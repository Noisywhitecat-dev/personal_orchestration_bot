import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../domain/agent-events.js';
import { asRunId } from '../../domain/ids.js';
import type { RunKind } from '../../domain/run.js';
import {
  ClaudeJsonlParser,
  PLAN_JSON_SCHEMA,
  REVIEW_JSON_SCHEMA,
  extractCandidate,
  jsonSchemaFor,
  parseClaudeUsage,
  validateResult,
} from './claude-jsonl-parser.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'claude');

function parseFixture(
  name: string,
  kind: RunKind,
  exit = { exitCode: 0, outcome: 'exited', stderrTail: '' },
  knownSession: string | null = null,
): { events: AgentEvent[]; parser: ClaudeJsonlParser } {
  const parser = new ClaudeJsonlParser(asRunId('run-1'), kind, () => 't', knownSession);
  const events: AgentEvent[] = [];
  for (const line of readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/)) {
    events.push(...parser.parseLine(line));
  }
  events.push(...parser.finish(exit));
  return { events, parser };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'run_completed' || e.type === 'run_failed');
const usage = (events: AgentEvent[]) => {
  const e = events.find((x) => x.type === 'usage_reported');
  if (!e || e.type !== 'usage_reported') throw new Error('no usage');
  return e.usage;
};
const completed = (events: AgentEvent[]) => {
  const e = events.find((x) => x.type === 'run_completed');
  if (!e || e.type !== 'run_completed') throw new Error('no run_completed');
  return e.result;
};
const failed = (events: AgentEvent[]) => {
  const e = events.find((x) => x.type === 'run_failed');
  if (!e || e.type !== 'run_failed') throw new Error('no run_failed');
  return e.error;
};

describe('ClaudeJsonlParser: events', () => {
  it('plan-success: init → session, thinking → reasoning, text → message, usage before completion', () => {
    const { events, parser } = parseFixture('plan-success.jsonl', 'plan');
    expect(types(events)).toEqual([
      'session_started',
      'reasoning_delta',
      'message_delta',
      'usage_reported',
      'run_completed',
    ]);
    expect(parser.state.sessionId).toBe('sess-plan-0001');
    const s = events[0];
    expect(s?.type === 'session_started' && s.sessionId).toBe('sess-plan-0001');
    const r = events[1];
    expect(r?.type === 'reasoning_delta' && r.text).toContain('header component');
    const m = events[2];
    expect(m?.type === 'message_delta' && m.text).toBe('I inspected the header. Here is the plan.');
    expect(completed(events)).toEqual({
      kind: 'plan',
      title: 'Add logout button',
      summary: 'Add a logout button to the header and cover it with a test.',
      steps: ['Add the button to Header', 'Wire the click to the auth service', 'Add a unit test'],
    });
    expect(terminals(events)).toHaveLength(1);
    // tool_use / user tool_result lines are neither events nor "unknown".
    expect(parser.state.unknownCount).toBe(0);
  });

  it('review approve and request_changes produce validated review results', () => {
    const a = completed(parseFixture('review-approve.jsonl', 'review').events);
    expect(a).toEqual({
      kind: 'review',
      verdict: 'approve',
      summary: 'Implementation matches the plan; tests pass.',
      changeRequests: [],
    });
    const c = completed(parseFixture('review-changes.jsonl', 'review').events);
    expect(c.kind === 'review' && c.verdict).toBe('request_changes');
    expect(c.kind === 'review' && c.changeRequests).toHaveLength(2);
  });

  it('CLI error result → run_failed CLAUDE_ERROR, nothing after it', () => {
    const { events } = parseFixture('cli-error.jsonl', 'plan');
    expect(types(events)).toEqual([
      'session_started',
      'message_delta',
      'usage_reported',
      'run_failed',
    ]);
    expect(failed(events)).toEqual({
      code: 'CLAUDE_ERROR',
      message: 'Authentication required: run claude login',
    });
  });

  it('banner, malformed JSON, unknown and stream_event lines are tolerated', () => {
    const { events, parser } = parseFixture('malformed.jsonl', 'plan');
    expect(parser.state.malformedCount).toBe(1); // "{not json at all"; "[1,2,3]" is skipped as non-object text
    expect(parser.state.unknownCount).toBe(1); // totally_new_event; stream_event is known-ignored
    expect(completed(events).kind).toBe('plan');
    expect(terminals(events)).toHaveLength(1);
  });

  it('duplicate terminal: only the first result counts; later init/error ignored', () => {
    const { events, parser } = parseFixture('duplicate-terminal.jsonl', 'review');
    expect(terminals(events)).toHaveLength(1);
    const r = completed(events);
    expect(r.kind === 'review' && r.verdict).toBe('approve');
    expect(usage(events).inputTokens).toBe(1);
    expect(events.filter((e) => e.type === 'session_started')).toHaveLength(1);
    expect(parser.state.sessionId).toBe('sess-dup');
  });

  it('known session id (resume) is not re-announced; a different id is', () => {
    const same = parseFixture('resume.jsonl', 'review', undefined, 'sess-plan-0001');
    expect(same.events.filter((e) => e.type === 'session_started')).toHaveLength(0);
    const other = parseFixture('resume.jsonl', 'review', undefined, 'some-other-session');
    const ids = other.events
      .filter((e) => e.type === 'session_started')
      .map((e) => (e.type === 'session_started' ? e.sessionId : ''));
    expect(ids).toEqual(['sess-plan-0001']);
  });

  it('process ended without a result → usage unavailable + run_failed with exit info', () => {
    const parser = new ClaudeJsonlParser(asRunId('r'), 'plan', () => 't');
    parser.parseLine('{"type":"system","subtype":"init","session_id":"s"}');
    const out = parser.finish({ exitCode: 3, outcome: 'exited', stderrTail: 'boom' });
    expect(types(out)).toEqual(['usage_reported', 'run_failed']);
    expect(usage(out).source).toBe('unavailable');
    expect(failed(out).code).toBe('CLAUDE_EXITED_WITHOUT_RESULT');
    expect(failed(out).message).toContain('boom');
    // finish() after a terminal emits nothing.
    expect(parser.finish({ exitCode: 0, outcome: 'exited', stderrTail: '' })).toEqual([]);
  });

  it('timeout / abort / spawn outcomes map to TIMEOUT / CANCELLED / SPAWN_FAILED', () => {
    for (const [outcome, code] of [
      ['timeout', 'TIMEOUT'],
      ['aborted', 'CANCELLED'],
      ['spawn_error', 'SPAWN_FAILED'],
    ] as const) {
      const out = new ClaudeJsonlParser(asRunId('r'), 'plan', () => 't').finish({
        exitCode: null,
        outcome,
        stderrTail: '',
      });
      expect(failed(out).code).toBe(code);
    }
  });

  it('assistant text is bounded and nothing is emitted after the terminal', () => {
    const parser = new ClaudeJsonlParser(asRunId('r'), 'review', () => 't');
    const big = 'x'.repeat(10_000);
    const ev = parser.parseLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } }),
    );
    expect(ev[0]?.type === 'message_delta' && ev[0].text.length).toBe(8_000);
    expect(
      parser.parseLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'more' }] },
        }),
      ),
    ).toEqual([]); // budget exhausted
    parser.parseLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }),
    );
    expect(parser.state.terminal).toBe(true);
    expect(
      parser.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'late' })),
    ).toEqual([]);
    expect(parser.state.sessionId).toBeNull();
  });
});

describe('ClaudeJsonlParser: structured results', () => {
  it('no structured_output but fenced JSON result → parsed; no usage → unavailable', () => {
    const { events } = parseFixture('no-usage.jsonl', 'plan');
    expect(types(events)).toEqual(['session_started', 'usage_reported', 'run_completed']);
    expect(usage(events)).toMatchObject({ source: 'unavailable', totalTokens: null });
    const plan = completed(events);
    expect(plan.kind === 'plan' && plan.title).toBe('Fenced plan');
  });

  it('empty steps → AGENT_RESULT_INVALID even though prose is present', () => {
    const { events } = parseFixture('invalid-result.jsonl', 'plan');
    expect(failed(events).code).toBe('AGENT_RESULT_INVALID');
    expect(terminals(events)).toHaveLength(1);
    expect(usage(events).source).toBe('actual');
  });

  it('prose-only result → AGENT_RESULT_INVALID (no natural-language extraction)', () => {
    const { events } = parseFixture('prose-only.jsonl', 'review');
    expect(failed(events).code).toBe('AGENT_RESULT_INVALID');
    expect(failed(events).message).toContain('no JSON result');
  });

  it('validateResult rejects wrong kind, bad verdict, missing fields, extra fields', () => {
    expect(
      validateResult('plan', {
        kind: 'review',
        verdict: 'approve',
        summary: 's',
        changeRequests: [],
      }),
    ).toBeNull();
    expect(
      validateResult('review', {
        kind: 'review',
        verdict: 'maybe',
        summary: 's',
        changeRequests: [],
      }),
    ).toBeNull();
    expect(
      validateResult('review', {
        kind: 'review',
        verdict: 'request_changes',
        summary: 's',
        changeRequests: [],
      }),
    ).toBeNull();
    expect(
      validateResult('review', { kind: 'review', verdict: 'approve', summary: 's' }),
    ).toBeNull();
    expect(
      validateResult('plan', { kind: 'plan', title: 't', summary: 's', steps: ['a'], extra: 1 }),
    ).toBeNull();
    expect(
      validateResult('plan', { kind: 'plan', title: ' ', summary: 's', steps: ['a'] }),
    ).toBeNull();
    expect(
      validateResult('implement', { kind: 'plan', title: 't', summary: 's', steps: ['a'] }),
    ).toBeNull();
    expect(validateResult('plan', 'not an object')).toBeNull();
    expect(
      validateResult('review', {
        kind: 'review',
        verdict: 'approve',
        summary: 's',
        changeRequests: [],
      }),
    ).not.toBeNull();
  });

  it('extractCandidate prefers structured_output, then JSON string, then fence', () => {
    expect(extractCandidate({ structured_output: { a: 1 }, result: '{"b":2}' })).toEqual({ a: 1 });
    expect(extractCandidate({ result: ' {"b":2} ' })).toEqual({ b: 2 });
    expect(extractCandidate({ result: '```json\n{"c":3}\n```' })).toEqual({ c: 3 });
    expect(extractCandidate({ result: 'Sure! ```json\n{"c":3}\n``` done' })).toBeUndefined();
    expect(extractCandidate({ result: 'plain prose' })).toBeUndefined();
    expect(extractCandidate({})).toBeUndefined();
  });

  it('JSON Schemas agree with the zod schemas on required fields and kinds', () => {
    expect(PLAN_JSON_SCHEMA.required).toEqual(['kind', 'title', 'summary', 'steps']);
    expect(REVIEW_JSON_SCHEMA.required).toEqual(['kind', 'verdict', 'summary', 'changeRequests']);
    expect(JSON.parse(jsonSchemaFor('plan'))).toEqual(PLAN_JSON_SCHEMA);
    expect(JSON.parse(jsonSchemaFor('review'))).toEqual(REVIEW_JSON_SCHEMA);
    expect(PLAN_JSON_SCHEMA.properties.steps.minItems).toBe(1);
    expect(REVIEW_JSON_SCHEMA.properties.verdict.enum).toEqual(['approve', 'request_changes']);
  });
});

describe('parseClaudeUsage', () => {
  it('sums input/cache_creation/cache_read into inputTokens; cached is a subset, not re-added', () => {
    const u = usage(parseFixture('plan-success.jsonl', 'plan').events);
    // input 120 + creation 300 + read 2000 = 2420 ; total = 2420 + 180
    expect(u).toEqual({
      inputTokens: 2420,
      cachedInputTokens: 2000,
      outputTokens: 180,
      reasoningTokens: null,
      totalTokens: 2600,
      source: 'actual',
    });
  });

  it('top-level usage wins over modelUsage (no double counting)', () => {
    const u = parseClaudeUsage({
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { m: { inputTokens: 999, outputTokens: 999 } },
    });
    expect(u).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(u?.cachedInputTokens).toBeNull();
  });

  it('modelUsage only: entries are summed once', () => {
    const u = usage(parseFixture('model-usage-only.jsonl', 'review').events);
    // a: 100 + 0 + 400 = 500 in, 20 out ; b: 10 + 50 + 0 = 60 in, 5 out
    expect(u).toEqual({
      inputTokens: 560,
      cachedInputTokens: 400,
      outputTokens: 25,
      reasoningTokens: null,
      totalTokens: 585,
      source: 'actual',
    });
  });

  it('missing fields stay null; cost is ignored', () => {
    expect(parseClaudeUsage({ usage: { output_tokens: 7 }, total_cost_usd: 99 })).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: 7,
      reasoningTokens: null,
      totalTokens: 7,
      source: 'actual',
    });
    expect(parseClaudeUsage({ total_cost_usd: 99 })).toBeNull();
    expect(parseClaudeUsage({ usage: {} })).toBeNull();
  });
});

describe('ClaudeJsonlParser: sanitized live capture (claude 2.1.260)', () => {
  // tests/fixtures/claude/live-auth-error-v2.1.260.jsonl is a field-whitelisted copy of one real
  // `claude --print --output-format stream-json --verbose --permission-mode plan --permission-prompts none
  // --json-schema …` run on 2.1.260 that failed at the API step (CLI not logged in). Session id, uuids,
  // cwd, tool lists and timestamps were replaced; field names and nesting are the real ones.
  it('maps the live init/assistant/result shapes; API failure → CLAUDE_ERROR with terminal_reason', () => {
    const { events, parser } = parseFixture('live-auth-error-v2.1.260.jsonl', 'plan');
    expect(types(events)).toEqual([
      'session_started',
      'message_delta',
      'usage_reported',
      'run_failed',
    ]);
    const s = events[0];
    expect(s?.type === 'session_started' && s.sessionId).toBe('sess-live-0001'); // redacted value
    expect(parser.state.unknownCount).toBe(0);
    expect(parser.state.malformedCount).toBe(0);
    expect(terminals(events)).toHaveLength(1);
    expect(types(events).indexOf('usage_reported')).toBeLessThan(
      types(events).indexOf('run_failed'),
    );
    // subtype is "success" but is_error is true: must still be a failure, never a plan.
    expect(failed(events).code).toBe('CLAUDE_ERROR');
    expect(failed(events).message).toBe(
      'Failed to authenticate: OAuth session expired and could not be refreshed (terminal_reason=api_error)',
    );
    // Real nested usage shape: zeros reported by the CLI are actual zeros, thinking tokens mapped.
    expect(usage(events)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      source: 'actual',
    });
  });

  it('live fixture carries no session ids, paths or machine details', () => {
    const text = readFileSync(join(FIXTURES, 'live-auth-error-v2.1.260.jsonl'), 'utf8');
    expect(text).not.toMatch(
      /[A-Za-z]:\|\/Users\/|AppData|cwd|memory_paths|messaging_socket_path|powershell_path/,
    );
    const uuids =
      text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(new Set(uuids)).toEqual(new Set(['00000000-0000-4000-8000-000000000001']));
    expect(text).toContain('"session_id":"sess-live-0001"');
  });

  it('thinking tokens from output_tokens_details map to reasoningTokens', () => {
    const u = parseClaudeUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 30,
        output_tokens_details: { thinking_tokens: 12 },
      },
    });
    expect(u).toMatchObject({ outputTokens: 30, reasoningTokens: 12, totalTokens: 40 });
  });
});

describe('ClaudeJsonlParser: sanitized live successful plan (claude 2.1.260)', () => {
  // tests/fixtures/claude/live-plan-v2.1.260.jsonl is a field-whitelisted copy of one real
  // successful `--permission-mode plan --json-schema …` run on 2.1.260 (23 stdout lines).
  // Session ids, uuids, tool inputs/results, paths and timings were replaced; field names,
  // nesting, event ordering and the usage numbers are the real ones.
  it('maps the live successful run to session/usage/plan with one terminal', () => {
    const { events } = parseFixture('live-plan-v2.1.260.jsonl', 'plan');
    // No text blocks and empty thinking strings in this run: the answer came via
    // StructuredOutput, so no message_delta / reasoning_delta is emitted.
    expect(types(events)).toEqual(['session_started', 'usage_reported', 'run_completed']);
    expect(terminals(events)).toHaveLength(1);
    expect(types(events).indexOf('usage_reported')).toBeLessThan(
      types(events).indexOf('run_completed'),
    );
    const s = events[0];
    expect(s?.type === 'session_started' && s.sessionId).toBe('sess-live-plan-0001');
    const plan = completed(events);
    expect(plan.kind).toBe('plan');
    expect(plan.kind === 'plan' && plan.title).toBe('Add hello.txt greeting file');
    expect(plan.kind === 'plan' && plan.steps).toHaveLength(3);
  });

  it('live line types are all known: rate_limit_event and system/thinking_tokens are ignored, not unknown', () => {
    const { parser } = parseFixture('live-plan-v2.1.260.jsonl', 'plan');
    expect(parser.state.unknownCount).toBe(0);
    expect(parser.state.malformedCount).toBe(0);
    const text = readFileSync(join(FIXTURES, 'live-plan-v2.1.260.jsonl'), 'utf8');
    expect(text).toContain('"type":"rate_limit_event"');
    expect(text).toContain('"subtype":"thinking_tokens"');
    expect(text).toContain('"type":"user"');
  });

  it('live usage: cache-creation and cache-read fold into inputTokens, thinking into reasoning', () => {
    // Real numbers: input 8 + cache_creation 36425 + cache_read 105666 = 142099 in; output 1058
    // (of which 346 thinking); total 143157.
    expect(usage(parseFixture('live-plan-v2.1.260.jsonl', 'plan').events)).toEqual({
      inputTokens: 142099,
      cachedInputTokens: 105666,
      outputTokens: 1058,
      reasoningTokens: 346,
      totalTokens: 143157,
      source: 'actual',
    });
  });

  it('live fixture carries no session ids, paths, tool inputs or machine details', () => {
    const text = readFileSync(join(FIXTURES, 'live-plan-v2.1.260.jsonl'), 'utf8');
    expect(text).not.toMatch(
      /[A-Za-z]:\|\/Users\/|AppData|"cwd"|memory_paths|messaging_socket_path/,
    );
    const uuids =
      text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(new Set(uuids)).toEqual(new Set(['00000000-0000-4000-8000-000000000002']));
    expect(text).toContain('"content":"<tool result redacted>"');
  });
});
