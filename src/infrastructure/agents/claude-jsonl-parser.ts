import { z } from 'zod';

import type { AgentEvent, AgentResult } from '../../domain/agent-events.js';
import { asSessionId, type IsoTimestamp, type RunId } from '../../domain/ids.js';
import type { RunKind } from '../../domain/run.js';
import { UNAVAILABLE_USAGE, type UsageSnapshot } from '../../domain/usage.js';

/**
 * Normalizes `claude -p --output-format stream-json --verbose` output into AgentEvents.
 *
 * Mapping (Claude Code 2.1.x stream-json; nothing outside this file knows the Claude shape):
 *
 * | Claude line                                                    | AgentEvent                       |
 * | -------------------------------------------------------------- | -------------------------------- |
 * | `{type:"system", subtype:"init", session_id}`                  | session_started                  |
 * | `{type:"assistant", message:{content:[{type:"text"}]}}`        | message_delta (whole text block) |
 * | `{type:"assistant", message:{content:[{type:"thinking"}]}}`    | reasoning_delta                  |
 * | `{type:"result", subtype:"success", usage, structured_output}` | usage_reported + run_completed   |
 * | `{type:"result", is_error:true | subtype:"error_*"}`           | usage_reported + run_failed      |
 * |   (live 2.1.260: subtype stays "success", is_error=true, terminal_reason="api_error")       |
 * | `{type:"user"}` (tool results), `stream_event`, `rate_limit_event`, `system` (non-init) | ignored |
 * | anything else                                                  | ignored, counted as unknown      |
 *
 * Result selection (no natural-language guessing):
 *   1. `structured_output` object
 *   2. else `result` string that parses as JSON
 *   3. else `result` wrapped in a ```json fence
 *   4. else AGENT_RESULT_INVALID
 * The parsed value must satisfy the zod schema for the run kind or the run fails.
 *
 * Guarantees: malformed / non-JSON lines never abort; at most one terminal event; exactly one
 * usage_reported per run, emitted before the terminal (`unavailable` if the CLI gave none);
 * nothing is emitted after the terminal; duplicate session ids are suppressed.
 */

const MAX_TEXT = 8_000;
const MAX_ERROR = 500;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));

// ---------- structured result schemas (also exported as JSON Schema for --json-schema) ----------

const nonEmpty = z.string().trim().min(1);

export const PlanResultSchema = z
  .object({
    kind: z.literal('plan'),
    title: nonEmpty,
    summary: nonEmpty,
    steps: z.array(nonEmpty).min(1),
    objective: nonEmpty.optional(),
    scope: z.array(nonEmpty).optional(),
    outOfScope: z.array(nonEmpty).optional(),
    acceptanceCriteria: z.array(nonEmpty).optional(),
    suggestedFiles: z.array(nonEmpty).optional(),
    verification: z.array(nonEmpty).optional(),
    risks: z.array(nonEmpty).optional(),
    riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export const ClarificationResultSchema = z
  .object({
    kind: z.literal('clarification'),
    question: nonEmpty,
  })
  .strict();

export const PlanningResultSchema = z.discriminatedUnion('kind', [
  PlanResultSchema,
  ClarificationResultSchema,
]);

export const ReviewResultSchema = z
  .object({
    kind: z.literal('review'),
    verdict: z.enum(['approve', 'request_changes']),
    summary: nonEmpty,
    changeRequests: z.array(nonEmpty),
  })
  .strict()
  .refine((r) => r.verdict !== 'request_changes' || r.changeRequests.length > 0, {
    message: 'request_changes requires at least one change request',
  });

/** JSON Schema handed to `claude --json-schema`. Kept in sync with the zod schemas above by tests. */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: ['plan', 'clarification'],
      description: 'Select plan when the request is actionable, otherwise clarification.',
    },
    title: { type: 'string', minLength: 1, description: 'Required when kind is plan.' },
    summary: { type: 'string', minLength: 1, description: 'Required when kind is plan.' },
    steps: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      description: 'Required when kind is plan.',
    },
    objective: { type: 'string', minLength: 1 },
    scope: { type: 'array', items: { type: 'string', minLength: 1 } },
    outOfScope: { type: 'array', items: { type: 'string', minLength: 1 } },
    acceptanceCriteria: { type: 'array', items: { type: 'string', minLength: 1 } },
    suggestedFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
    verification: { type: 'array', items: { type: 'string', minLength: 1 } },
    risks: { type: 'array', items: { type: 'string', minLength: 1 } },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
    question: {
      type: 'string',
      minLength: 1,
      description: 'Required when kind is clarification.',
    },
  },
} as const;

export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'verdict', 'summary', 'changeRequests'],
  properties: {
    kind: { type: 'string', enum: ['review'] },
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: { type: 'string', minLength: 1 },
    changeRequests: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
} as const;

export function jsonSchemaFor(kind: 'plan' | 'review'): string {
  return JSON.stringify(kind === 'plan' ? PLAN_JSON_SCHEMA : REVIEW_JSON_SCHEMA);
}

/** Validate a candidate result for the run kind. Returns null when invalid. */
export function validateResult(kind: RunKind, candidate: unknown): AgentResult | null {
  if (kind === 'plan') {
    const r = PlanningResultSchema.safeParse(candidate);
    return r.success ? r.data : null;
  }
  if (kind === 'review') {
    const r = ReviewResultSchema.safeParse(candidate);
    return r.success ? r.data : null;
  }
  return null;
}

const FENCE = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/;

/** Extract the candidate result object from a terminal `result` line without guessing. */
export function extractCandidate(obj: Json): unknown {
  if (isObj(obj['structured_output'])) return obj['structured_output'];
  const text = str(obj['result']);
  if (text === null) return undefined;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;
  const m = FENCE.exec(text);
  if (m?.[1] !== undefined) return tryParse(m[1]);
  return undefined;
}

// ---------- usage ----------

/**
 * Claude reports uncached input, cache-creation input and cache-read input separately.
 *   inputTokens       = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   cachedInputTokens = cache_read_input_tokens   (a subset of inputTokens, never added again)
 *   outputTokens      = output_tokens
 *   totalTokens       = inputTokens + outputTokens
 * Top-level `usage` wins; `modelUsage` (per model) is summed only when `usage` is absent.
 * Cost fields are ignored: never converted into tokens.
 */
export function parseClaudeUsage(obj: Json): UsageSnapshot | null {
  const usage = isObj(obj['usage']) ? obj['usage'] : null;
  if (usage) return fromUsage(usage);
  const perModel = isObj(obj['modelUsage']) ? Object.values(obj['modelUsage']) : [];
  if (perModel.length === 0) return null;
  let input = 0;
  let cached = 0;
  let output = 0;
  let any = false;
  for (const m of perModel) {
    if (!isObj(m)) continue;
    const i = num(m['inputTokens']) ?? 0;
    const cc = num(m['cacheCreationInputTokens']) ?? 0;
    const cr = num(m['cacheReadInputTokens']) ?? 0;
    const o = num(m['outputTokens']) ?? 0;
    if ([m['inputTokens'], m['outputTokens']].some((v) => typeof v === 'number')) any = true;
    input += i + cc + cr;
    cached += cr;
    output += o;
  }
  if (!any) return null;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: null,
    totalTokens: input + output,
    source: 'actual',
  };
}

function fromUsage(u: Json): UsageSnapshot | null {
  const raw = num(u['input_tokens']);
  const creation = num(u['cache_creation_input_tokens']);
  const read = num(u['cache_read_input_tokens']);
  const output = num(u['output_tokens']);
  // Live 2.1.260 shape: thinking tokens are nested under output_tokens_details (a subset of output).
  const details = isObj(u['output_tokens_details']) ? u['output_tokens_details'] : null;
  const reasoning = details ? num(details['thinking_tokens']) : null;
  if (raw === null && creation === null && read === null && output === null) return null;
  const input =
    raw === null && creation === null && read === null
      ? null
      : (raw ?? 0) + (creation ?? 0) + (read ?? 0);
  const total = input === null && output === null ? null : (input ?? 0) + (output ?? 0);
  return {
    inputTokens: input,
    cachedInputTokens: read,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
    source: 'actual',
  };
}

// ---------- parser ----------

export interface ClaudeParserState {
  sessionId: string | null;
  usageReported: boolean;
  terminal: boolean;
  unknownCount: number;
  malformedCount: number;
  textBytes: number;
}

export class ClaudeJsonlParser {
  readonly state: ClaudeParserState = {
    sessionId: null,
    usageReported: false,
    terminal: false,
    unknownCount: 0,
    malformedCount: 0,
    textBytes: 0,
  };

  constructor(
    private readonly runId: RunId,
    private readonly kind: RunKind,
    private readonly now: () => IsoTimestamp,
    /** Session id known before the run (resume). Re-announcements of it are suppressed. */
    knownSessionId: string | null = null,
  ) {
    this.state.sessionId = knownSessionId;
  }

  private base(): { runId: RunId; timestamp: IsoTimestamp } {
    return { runId: this.runId, timestamp: this.now() };
  }

  /** Parse one stdout line. Never throws on bad input. */
  parseLine(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
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
    if (this.state.terminal) return [];

    switch (str(obj['type'])) {
      case 'system':
        return this.system(obj);
      case 'assistant':
        return this.assistant(obj);
      case 'result':
        return this.result(obj);
      case 'user': // tool results
      case 'stream_event':
      case 'rate_limit_event': // live 2.1.260 progress telemetry
        return [];
      default:
        this.state.unknownCount += 1;
        return [];
    }
  }

  /** After stdout is exhausted: guarantee usage + a terminal derived from how the process ended. */
  finish(exit: { exitCode: number | null; outcome: string; stderrTail: string }): AgentEvent[] {
    if (this.state.terminal) return [];
    const out = this.usageOnce(null);
    this.state.terminal = true;
    const code =
      exit.outcome === 'timeout'
        ? 'TIMEOUT'
        : exit.outcome === 'aborted'
          ? 'CANCELLED'
          : exit.outcome === 'spawn_error'
            ? 'SPAWN_FAILED'
            : 'CLAUDE_EXITED_WITHOUT_RESULT';
    const detail = exit.stderrTail.trim().length
      ? ` stderr: ${clip(exit.stderrTail.trim(), MAX_ERROR)}`
      : '';
    out.push({
      ...this.base(),
      type: 'run_failed',
      error: {
        code,
        message: `Claude ended (${exit.outcome}, exit=${String(exit.exitCode)}) without a result; unknown=${this.state.unknownCount} malformed=${this.state.malformedCount}.${detail}`,
      },
    });
    return out;
  }

  private system(obj: Json): AgentEvent[] {
    if (str(obj['subtype']) !== 'init') return [];
    return this.session(str(obj['session_id']));
  }

  private session(id: string | null): AgentEvent[] {
    if (!id || id === this.state.sessionId) return [];
    this.state.sessionId = id;
    return [{ ...this.base(), type: 'session_started', sessionId: asSessionId(id) }];
  }

  private assistant(obj: Json): AgentEvent[] {
    const out: AgentEvent[] = [];
    const message = isObj(obj['message']) ? obj['message'] : null;
    const content = message ? message['content'] : null;
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (!isObj(block)) continue;
      const type = str(block['type']);
      if (type === 'text') {
        const text = str(block['text']) ?? '';
        if (text && this.state.textBytes < MAX_TEXT) {
          const piece = clip(text, MAX_TEXT - this.state.textBytes);
          this.state.textBytes += piece.length;
          out.push({ ...this.base(), type: 'message_delta', text: piece });
        }
      } else if (type === 'thinking') {
        const text = str(block['thinking']) ?? '';
        if (text) out.push({ ...this.base(), type: 'reasoning_delta', text: clip(text, MAX_TEXT) });
      }
      // tool_use blocks are not surfaced; plan mode limits them to read-only tools.
    }
    return out;
  }

  private result(obj: Json): AgentEvent[] {
    const out = this.usageOnce(parseClaudeUsage(obj));
    this.state.terminal = true;
    // A result line may carry the session id too (first sight of it on some versions).
    out.push(...this.session(str(obj['session_id'])));

    const subtype = str(obj['subtype']) ?? '';
    const isError = obj['is_error'] === true || subtype.startsWith('error');
    if (isError) {
      const errors = Array.isArray(obj['errors'])
        ? obj['errors'].filter((e): e is string => typeof e === 'string')
        : [];
      // Live 2.1.260: an API failure still reports subtype "success" with is_error=true, no
      // `errors` array, the message in `result`, and the cause in `terminal_reason`.
      const reason = str(obj['terminal_reason']);
      const message =
        errors[0] ?? str(obj['result']) ?? `Claude reported ${subtype || 'an error'}.`;
      const detail = reason && reason !== 'success' ? ` (terminal_reason=${reason})` : '';
      out.push({
        ...this.base(),
        type: 'run_failed',
        error: { code: 'CLAUDE_ERROR', message: clip(message + detail, MAX_ERROR) },
      });
      return out;
    }

    const candidate = extractCandidate(obj);
    const result = validateResult(this.kind, candidate);
    if (!result) {
      out.push({
        ...this.base(),
        type: 'run_failed',
        error: {
          code: 'AGENT_RESULT_INVALID',
          message:
            candidate === undefined
              ? `Claude returned no JSON result for kind '${this.kind}'.`
              : `Claude result does not match the '${this.kind}' schema.`,
        },
      });
      return out;
    }
    out.push({ ...this.base(), type: 'run_completed', result });
    return out;
  }

  private usageOnce(usage: UsageSnapshot | null): AgentEvent[] {
    if (this.state.usageReported) return [];
    this.state.usageReported = true;
    return [{ ...this.base(), type: 'usage_reported', usage: usage ?? UNAVAILABLE_USAGE }];
  }
}
