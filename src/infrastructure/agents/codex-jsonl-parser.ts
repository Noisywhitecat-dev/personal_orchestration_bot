import type { AgentEvent, AgentResult } from '../../domain/agent-events.js';
import { asSessionId, type IsoTimestamp, type RunId } from '../../domain/ids.js';
import { UNAVAILABLE_USAGE, type UsageSnapshot } from '../../domain/usage.js';

/**
 * Normalizes `codex exec --json` JSONL into AgentEvents.
 *
 * Mapping (codex-cli 0.154.x event shapes; adjust here if the CLI changes — nothing else
 * in the codebase knows about Codex JSON):
 *
 * | Codex line                                              | AgentEvent                         |
 * | ------------------------------------------------------- | ---------------------------------- |
 * | `{type:"thread.started", thread_id}`                    | session_started                    |
 * | `{type:"session.created"|"session_started", session_id}`| session_started (older shape)      |
 * | `{type:"item.completed", item:{type:"agent_message"}}`  | message_delta (full text)          |
 * | `{type:"item.updated",   item:{type:"agent_message"}}`  | message_delta (delta only)         |
 * | `{type:"item.completed", item:{type:"reasoning"}}`      | reasoning_delta                    |
 * | `{type:"item.started",   item:{type:"command_execution"}}` | command_started                 |
 * | `{type:"item.completed", item:{type:"command_execution"}}` | command_completed               |
 * | `{type:"item.completed", item:{type:"file_change"}}`    | (tracked → changedFiles)           |
 * | `{type:"turn.completed", usage:{...}}`                  | usage_reported (actual)            |
 * | `{type:"turn.completed"}` / `thread.completed`          | run_completed (implementation)     |
 * | `{type:"turn.failed", error}` / `{type:"error", message}` | run_failed                      |
 * | anything else                                           | ignored, counted                   |
 *
 * Guarantees:
 * - non-JSON / malformed lines never abort the run
 * - at most one terminal event; later terminals are ignored
 * - exactly one usage_reported per run, always emitted before the terminal event
 *   (`unavailable` when the CLI reported nothing)
 */

const MAX_TAIL = 2_000;
const MAX_SUMMARY = 2_000;
const TEST_COMMAND_PREFIXES = [
  'npm test',
  'npm run test',
  'npx vitest',
  'vitest',
  'pnpm test',
  'yarn test',
  'pytest',
  'go test',
  'cargo test',
  'dotnet test',
  'mvn test',
  'gradle test',
];

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tail = (s: string, max = MAX_TAIL): string => (s.length <= max ? s : s.slice(s.length - max));

function commandToArray(cmd: unknown): string[] {
  if (Array.isArray(cmd)) return cmd.filter((c): c is string => typeof c === 'string');
  if (typeof cmd === 'string') return cmd.trim().length ? cmd.trim().split(/\s+/) : [];
  return [];
}

function isTestCommand(command: string[]): boolean {
  const joined = command.join(' ');
  return TEST_COMMAND_PREFIXES.some((p) => joined === p || joined.startsWith(p + ' '));
}

function parseUsage(u: unknown): UsageSnapshot | null {
  if (!isObj(u)) return null;
  const input = num(u['input_tokens']);
  const cached = num(u['cached_input_tokens']);
  const output = num(u['output_tokens']);
  const reasoning = num(u['reasoning_output_tokens'] ?? u['reasoning_tokens']);
  let total = num(u['total_tokens']);
  if (total === null && (input !== null || output !== null)) total = (input ?? 0) + (output ?? 0);
  if (input === null && output === null && total === null) return null;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
    source: 'actual',
  };
}

export interface ParserState {
  sessionId: string | null;
  usageReported: boolean;
  terminal: boolean;
  unknownCount: number;
  malformedCount: number;
  lastMessage: string;
  changedFiles: string[];
  /** null = no test command ran; otherwise last test command's pass/fail. */
  testsPassed: boolean | null;
}

export class CodexJsonlParser {
  readonly state: ParserState = {
    sessionId: null,
    usageReported: false,
    terminal: false,
    unknownCount: 0,
    malformedCount: 0,
    lastMessage: '',
    changedFiles: [],
    testsPassed: null,
  };

  constructor(
    private readonly runId: RunId,
    private readonly now: () => IsoTimestamp,
  ) {}

  private base(): { runId: RunId; timestamp: IsoTimestamp } {
    return { runId: this.runId, timestamp: this.now() };
  }

  /** Parse one stdout line. Returns zero or more events. Never throws on bad input. */
  parseLine(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return []; // banner / blank / progress text
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      this.state.malformedCount += 1;
      return [];
    }
    if (!isObj(obj)) {
      this.state.malformedCount += 1;
      return [];
    }
    if (this.state.terminal) return []; // ignore everything after the first terminal event

    const type = str(obj['type']) ?? '';
    switch (type) {
      case 'thread.started':
      case 'session.created':
      case 'session_started': {
        const id = str(obj['thread_id']) ?? str(obj['session_id']) ?? str(obj['id']);
        if (!id) return this.unknown();
        this.state.sessionId = id;
        return [{ ...this.base(), type: 'session_started', sessionId: asSessionId(id) }];
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(type, obj['item']);
      case 'turn.completed':
      case 'thread.completed':
        return this.completed(obj);
      case 'turn.failed':
      case 'error':
        return this.failed(obj);
      default:
        return this.unknown();
    }
  }

  /**
   * Call after stdout is exhausted. Emits the usage fallback and, if no terminal event was seen,
   * a run_failed derived from the process exit.
   */
  finish(exit: { exitCode: number | null; outcome: string; stderrTail: string }): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (!this.state.terminal) {
      out.push(...this.usageOnce(null));
      this.state.terminal = true;
      const code =
        exit.outcome === 'timeout'
          ? 'TIMEOUT'
          : exit.outcome === 'aborted'
            ? 'CANCELLED'
            : exit.outcome === 'spawn_error'
              ? 'SPAWN_FAILED'
              : 'CODEX_EXITED_WITHOUT_RESULT';
      const detail = exit.stderrTail.trim().length ? ` stderr: ${tail(exit.stderrTail, 500)}` : '';
      out.push({
        ...this.base(),
        type: 'run_failed',
        error: {
          code,
          message: `Codex ended (${exit.outcome}, exit=${String(exit.exitCode)}) without a completion event; unknown=${this.state.unknownCount} malformed=${this.state.malformedCount}.${detail}`,
        },
      });
    }
    return out;
  }

  private unknown(): AgentEvent[] {
    this.state.unknownCount += 1;
    return [];
  }

  private item(phase: string, item: unknown): AgentEvent[] {
    if (!isObj(item)) return this.unknown();
    const itemType = str(item['type']) ?? '';
    const id = str(item['id']) ?? `item-${this.state.unknownCount}`;

    switch (itemType) {
      case 'agent_message': {
        if (phase === 'item.started') return [];
        const text = str(item['text']) ?? str(item['delta']) ?? '';
        if (phase === 'item.completed') this.state.lastMessage = text || this.state.lastMessage;
        if (!text) return [];
        return [{ ...this.base(), type: 'message_delta', text }];
      }
      case 'reasoning': {
        const text = str(item['text']) ?? str(item['delta']) ?? '';
        return text ? [{ ...this.base(), type: 'reasoning_delta', text }] : [];
      }
      case 'command_execution': {
        const command = commandToArray(item['command']);
        if (phase === 'item.started') {
          return [
            {
              ...this.base(),
              type: 'command_started',
              commandId: id,
              command,
              cwd: str(item['cwd']) ?? '',
            },
          ];
        }
        if (phase === 'item.completed') {
          const exitCode = num(item['exit_code']);
          if (isTestCommand(command) && exitCode !== null) this.state.testsPassed = exitCode === 0;
          const stdout = str(item['aggregated_output']) ?? str(item['stdout']) ?? '';
          const stderr = str(item['stderr']) ?? '';
          return [
            {
              ...this.base(),
              type: 'command_completed',
              commandId: id,
              exitCode,
              stdoutTail: tail(stdout),
              stderrTail: tail(stderr),
            },
          ];
        }
        return [];
      }
      case 'file_change': {
        if (phase !== 'item.completed') return [];
        const changes = item['changes'];
        if (Array.isArray(changes)) {
          for (const c of changes) {
            const p = isObj(c) ? str(c['path']) : null;
            if (p && !this.state.changedFiles.includes(p)) this.state.changedFiles.push(p);
          }
        }
        return [];
      }
      default:
        return this.unknown();
    }
  }

  /** Emit usage once. Called right before any terminal event so consumers that stop at the terminal still see it. */
  private usageOnce(usage: UsageSnapshot | null): AgentEvent[] {
    if (this.state.usageReported) return [];
    this.state.usageReported = true;
    return [{ ...this.base(), type: 'usage_reported', usage: usage ?? UNAVAILABLE_USAGE }];
  }

  private completed(obj: Json): AgentEvent[] {
    const out = this.usageOnce(parseUsage(obj['usage']));
    this.state.terminal = true;
    out.push({ ...this.base(), type: 'run_completed', result: this.buildResult() });
    return out;
  }

  private failed(obj: Json): AgentEvent[] {
    const out = this.usageOnce(null);
    this.state.terminal = true;
    const err = obj['error'];
    const message =
      (isObj(err) ? str(err['message']) : null) ??
      str(obj['message']) ??
      'Codex reported an error.';
    const code = (isObj(err) ? str(err['code']) : null) ?? 'CODEX_ERROR';
    out.push({ ...this.base(), type: 'run_failed', error: { code, message: tail(message, 500) } });
    return out;
  }

  buildResult(): AgentResult {
    const summary = this.state.lastMessage.trim().length
      ? this.state.lastMessage.trim().slice(0, MAX_SUMMARY)
      : 'Codex run completed.';
    return {
      kind: 'implementation',
      summary,
      changedFiles: [...this.state.changedFiles],
      testsPassed: this.state.testsPassed,
    };
  }
}
