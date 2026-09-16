import { claudeEventQuota, type QuotaWindow } from '../../shared/account-usage.js';
import type { AgentEvent } from '../../domain/agent-events.js';
import { OrchestrationError } from '../../domain/errors.js';
import type { RunId, SessionId } from '../../domain/ids.js';
import type { Clock } from '../../domain/ports.js';
import type { RunKind } from '../../domain/run.js';
import { UNAVAILABLE_USAGE } from '../../domain/usage.js';
import { runProcess, type RunningProcess } from '../process/process-runner.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';
import { ClaudeJsonlParser, jsonSchemaFor } from './claude-jsonl-parser.js';

/**
 * Real Claude Code CLI adapter for the planner / reviewer role. Read-only by construction.
 * Verified against `claude 2.1.260` `--help`:
 *
 *   start : claude --print --output-format stream-json --verbose --permission-mode plan
 *           --permission-prompts none --json-schema <schema> [--max-turns N] [--model M]
 *   resume: same flags + --resume <sessionId>
 *
 * The prompt is always written to stdin (never argv). `--max-turns` is NOT listed by 2.1.260's
 * help, so it is only passed when explicitly configured (`CLAUDE_MAX_TURNS`). `--continue` is
 * never used: it silently picks the most recent session.
 *
 * Only `plan` and `review` runs are supported; `implement` / `revise` fail with UNSUPPORTED_KIND
 * without spawning anything. Claude never gets write permissions from this adapter.
 */

export const CLAUDE_PERMISSION_MODE = 'plan';
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Never allowed in argv. */
export const FORBIDDEN_CLAUDE_ARGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--continue',
  '-c',
];

/** `--permission-mode` values that grant writes or bypass checks. Only `plan` is allowed. */
export const FORBIDDEN_PERMISSION_MODES: readonly string[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'manual',
  'default',
];

export function assertNoForbiddenClaudeArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (FORBIDDEN_CLAUDE_ARGS.includes(a)) {
      throw new OrchestrationError('VALIDATION_FAILED', `Forbidden Claude option: ${a}`);
    }
    const modeInline = /^--permission-mode=(.+)$/.exec(a);
    const mode = modeInline?.[1] ?? (a === '--permission-mode' ? (args[i + 1] ?? '') : null);
    if (mode !== null && mode !== CLAUDE_PERMISSION_MODE) {
      throw new OrchestrationError(
        'VALIDATION_FAILED',
        `Forbidden Claude permission mode: ${mode || '(missing)'}`,
      );
    }
    if (FORBIDDEN_PERMISSION_MODES.some((m) => a === `--permission-mode=${m}`)) {
      throw new OrchestrationError('VALIDATION_FAILED', `Forbidden Claude permission mode: ${a}`);
    }
  }
  if (!args.includes('--permission-mode')) {
    throw new OrchestrationError(
      'VALIDATION_FAILED',
      'Claude argv must pin --permission-mode plan',
    );
  }
}

/** UUID-ish or slug ids only; must not look like an option. */
export function assertValidClaudeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sessionId)) {
    throw new OrchestrationError('VALIDATION_FAILED', 'Claude session id has an invalid format.');
  }
}

export interface ClaudeArgsOptions {
  kind: 'plan' | 'review';
  /** Passed as `--max-turns` only when set (not advertised by 2.1.260 help). */
  maxTurns?: number;
  model?: string;
  effort?: ClaudeEffort;
}

function commonArgs(opts: ClaudeArgsOptions): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    CLAUDE_PERMISSION_MODE,
    '--permission-prompts',
    'none',
    '--json-schema',
    jsonSchemaFor(opts.kind),
  ];
  if (opts.maxTurns !== undefined) {
    if (!Number.isInteger(opts.maxTurns) || opts.maxTurns <= 0) {
      throw new OrchestrationError('VALIDATION_FAILED', 'maxTurns must be a positive integer.');
    }
    args.push('--max-turns', String(opts.maxTurns));
  }
  if (opts.model !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(opts.model)) {
      throw new OrchestrationError('VALIDATION_FAILED', 'model has an invalid format.');
    }
    args.push('--model', opts.model);
  }
  if (opts.effort !== undefined) args.push('--effort', opts.effort);
  return args;
}

/** Pure. argv for a new session (after the executable). Prompt goes to stdin. */
export function buildClaudeStartArgs(opts: ClaudeArgsOptions): string[] {
  const args = commonArgs(opts);
  assertNoForbiddenClaudeArgs(args);
  return args;
}

/** Pure. argv for resuming an existing session. */
export function buildClaudeResumeArgs(opts: ClaudeArgsOptions & { sessionId: string }): string[] {
  assertValidClaudeSessionId(opts.sessionId);
  const args = [...commonArgs(opts), '--resume', opts.sessionId];
  assertNoForbiddenClaudeArgs(args);
  return args;
}

export interface ClaudeCliAdapterOptions {
  onQuota?: ((windows: QuotaWindow[]) => void) | undefined;
  /** Executable name or absolute path. Default `claude`. Tests pass node + a stub script. */
  executable?: string;
  /** Inserted before the claude argv (stub script path in tests). */
  extraArgs?: string[];
  clock: Clock;
  timeoutMs?: number;
  maxTurns?: number;
  model?: string;
  effort?: ClaudeEffort;
  env?: Record<string, string>;
  log?: (line: string) => void;
  killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ClaudeCliAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private readonly onQuota: ((windows: QuotaWindow[]) => void) | undefined;
  private readonly executable: string;
  private readonly extraArgs: string[];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxTurns: number | undefined;
  private readonly model: string | undefined;
  private readonly effort: ClaudeEffort | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly log: ((line: string) => void) | undefined;
  private readonly killGraceMs: number | undefined;
  private readonly controllers = new Map<RunId, AbortController>();

  constructor(opts: ClaudeCliAdapterOptions) {
    this.onQuota = opts.onQuota;
    this.executable = opts.executable ?? 'claude';
    this.extraArgs = opts.extraArgs ?? [];
    this.clock = opts.clock;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTurns = opts.maxTurns;
    this.model = opts.model;
    this.effort = opts.effort;
    this.env = opts.env;
    this.log = opts.log;
    this.killGraceMs = opts.killGraceMs;
  }

  start(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.run(input, null);
  }

  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.run(input, sessionId);
  }

  async cancel(runId: RunId): Promise<void> {
    this.controllers.get(runId)?.abort();
  }

  /** Number of runs currently tracked; exposed for tests. */
  get activeRuns(): number {
    return this.controllers.size;
  }

  private async *run(
    input: AgentRunInput,
    resumeSessionId: SessionId | null,
  ): AsyncGenerator<AgentEvent> {
    const now = () => this.clock.now();
    const base = () => ({ runId: input.runId, timestamp: now() });

    if (!isSupportedKind(input.kind)) {
      yield { ...base(), type: 'usage_reported', usage: UNAVAILABLE_USAGE };
      yield {
        ...base(),
        type: 'run_failed',
        error: {
          code: 'UNSUPPORTED_KIND',
          message: `Claude adapter cannot run kind '${input.kind}'.`,
        },
      };
      return;
    }

    let args: string[];
    try {
      const opts: ClaudeArgsOptions = {
        kind: input.kind,
        ...(this.maxTurns !== undefined ? { maxTurns: this.maxTurns } : {}),
        ...(this.model !== undefined ? { model: this.model } : {}),
        ...(this.effort !== undefined ? { effort: this.effort } : {}),
      };
      args = resumeSessionId
        ? buildClaudeResumeArgs({ ...opts, sessionId: resumeSessionId })
        : buildClaudeStartArgs(opts);
    } catch (err) {
      const e =
        err instanceof OrchestrationError ? err : new OrchestrationError('INTERNAL', String(err));
      yield { ...base(), type: 'usage_reported', usage: UNAVAILABLE_USAGE };
      yield { ...base(), type: 'run_failed', error: { code: e.code, message: e.message } };
      return;
    }

    const controller = new AbortController();
    this.controllers.set(input.runId, controller);
    const signal = AbortSignal.any(
      input.signal ? [controller.signal, input.signal] : [controller.signal],
    );
    const parser = new ClaudeJsonlParser(input.runId, input.kind, now, resumeSessionId);

    let proc: RunningProcess;
    try {
      proc = runProcess({
        file: this.executable,
        args: [...this.extraArgs, ...args],
        cwd: input.projectRoot,
        projectRoot: input.projectRoot,
        stdin: input.prompt,
        timeoutMs: this.timeoutMs,
        signal,
        ...(this.env ? { env: this.env } : {}),
        ...(this.log ? { log: this.log } : {}),
        ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
      });
    } catch (err) {
      this.controllers.delete(input.runId);
      const e =
        err instanceof OrchestrationError
          ? err
          : new OrchestrationError('AGENT_RUN_FAILED', String(err));
      yield { ...base(), type: 'usage_reported', usage: UNAVAILABLE_USAGE };
      yield { ...base(), type: 'run_failed', error: { code: e.code, message: e.message } };
      return;
    }

    try {
      // Resume: re-announce the known id; the parser suppresses the CLI echoing the same id.
      if (resumeSessionId) yield { ...base(), type: 'session_started', sessionId: resumeSessionId };

      for await (const line of proc.stdoutLines()) {
        const quota = claudeEventQuota(line);
        if (quota.length) this.onQuota?.(quota);
        for (const event of parser.parseLine(line)) yield event;
      }
      const result = await proc.done;
      for (const event of parser.finish(result)) yield event;
    } finally {
      this.controllers.delete(input.runId);
    }
  }
}

function isSupportedKind(kind: RunKind): kind is 'plan' | 'review' {
  return kind === 'plan' || kind === 'review';
}
