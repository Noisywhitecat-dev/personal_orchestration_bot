import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../src/domain/agent-events.js';
import { asRunId, asSessionId, asTaskId } from '../../src/domain/ids.js';
import { FixedClock } from '../../src/domain/ports.js';
import type { AgentRunInput } from '../../src/infrastructure/agents/agent-adapter.js';
import { ClaudeCliAdapter } from '../../src/infrastructure/agents/claude-cli-adapter.js';
import { trackedChildCount } from '../../src/infrastructure/process/process-runner.js';

// The adapter runs `node tests/fixtures/claude/stub-claude.mjs`, which replays a fixture.
// No real `claude` binary and no model call anywhere in this file.

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'claude');
const STUB = join(FIXTURES, 'stub-claude.mjs');

let projectRoot: string;

beforeAll(() => {
  projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-adapter-')));
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function adapter(
  env: Record<string, string>,
  extra: Partial<ConstructorParameters<typeof ClaudeCliAdapter>[0]> = {},
) {
  return new ClaudeCliAdapter({
    executable: process.execPath,
    extraArgs: [STUB],
    clock: new FixedClock(),
    env,
    timeoutMs: 5_000,
    killGraceMs: 50,
    ...extra,
  });
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: asRunId('run-1'),
    taskId: asTaskId('task-1'),
    projectRoot,
    kind: 'plan',
    prompt: 'Plan the logout button',
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'run_completed' || e.type === 'run_failed');
const fixture = (name: string) => ({ STUB_FIXTURE: join(FIXTURES, name) });
const lastError = (events: AgentEvent[]) => {
  const e = events.at(-1);
  if (e?.type !== 'run_failed') throw new Error(`expected run_failed, got ${e?.type}`);
  return e.error;
};

/** Run the stub and return what it observed (argv, cwd, stdin size) via an echo file. */
async function echoRun(
  env: Record<string, string>,
  run: (a: ClaudeCliAdapter) => AsyncIterable<AgentEvent>,
) {
  const file = join(projectRoot, `echo-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const a = adapter({ ...env, STUB_ECHO_FILE: file });
  await collect(run(a));
  return JSON.parse(readFileSync(file, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdinBytes: number;
  };
}

describe('ClaudeCliAdapter (stub executable)', () => {
  it('plan start: normalized events, session, validated plan result', async () => {
    const events = await collect(adapter(fixture('plan-success.jsonl')).start(input()));
    expect(types(events)).toEqual([
      'session_started',
      'reasoning_delta',
      'message_delta',
      'usage_reported',
      'run_completed',
    ]);
    const done = events.at(-1);
    if (done?.type !== 'run_completed' || done.result.kind !== 'plan')
      throw new Error('bad terminal');
    expect(done.result.title).toBe('Add logout button');
    expect(done.result.steps).toHaveLength(3);
    const u = events.find((e) => e.type === 'usage_reported');
    expect(u?.type === 'usage_reported' && u.usage).toMatchObject({
      source: 'actual',
      totalTokens: 2600,
    });
    expect(terminals(events)).toHaveLength(1);
  });

  it('review approve / request_changes', async () => {
    const ok = await collect(
      adapter(fixture('review-approve.jsonl')).start(input({ kind: 'review' })),
    );
    const a = ok.at(-1);
    expect(a?.type === 'run_completed' && a.result.kind === 'review' && a.result.verdict).toBe(
      'approve',
    );

    const ch = await collect(
      adapter(fixture('review-changes.jsonl')).start(input({ kind: 'review' })),
    );
    const c = ch.at(-1);
    expect(c?.type === 'run_completed' && c.result.kind === 'review' && c.result.verdict).toBe(
      'request_changes',
    );
    expect(
      c?.type === 'run_completed' && c.result.kind === 'review' && c.result.changeRequests,
    ).toHaveLength(2);
  });

  it('resume: re-announces the known id once, passes --resume, result parsed', async () => {
    const events = await collect(
      adapter(fixture('resume.jsonl')).resume(
        asSessionId('sess-plan-0001'),
        input({ kind: 'review' }),
      ),
    );
    const sessions = events.filter((e) => e.type === 'session_started');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.type === 'session_started' && sessions[0].sessionId).toBe('sess-plan-0001');
    expect(events.at(-1)?.type).toBe('run_completed');

    const seen = await echoRun(fixture('resume.jsonl'), (a) =>
      a.resume(asSessionId('sess-plan-0001'), input({ kind: 'review' })),
    );
    expect(seen.argv).toContain('--resume');
    expect(seen.argv[seen.argv.indexOf('--resume') + 1]).toBe('sess-plan-0001');
    expect(seen.argv).not.toContain('--continue');
  });

  it('resume: a different id from the CLI is passed through after the known one', async () => {
    const events = await collect(
      adapter(fixture('plan-success.jsonl')).resume(asSessionId('old-session'), input()),
    );
    const ids = events
      .filter((e) => e.type === 'session_started')
      .map((e) => (e.type === 'session_started' ? e.sessionId : ''));
    expect(ids).toEqual(['old-session', 'sess-plan-0001']);
  });

  it('passes the prompt on stdin only, cwd = project root, read-only argv', async () => {
    const prompt = 'PROMPT-BODY-' + 'z'.repeat(100);
    const seen = await echoRun({}, (a) => a.start(input({ prompt })));
    expect(seen.stdinBytes).toBe(Buffer.byteLength(prompt));
    expect(seen.argv.join(' ')).not.toContain('PROMPT-BODY');
    expect(realpathSync.native(seen.cwd)).toBe(projectRoot);
    expect(seen.argv.slice(0, 6)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
    ]);
    expect(seen.argv).toContain('--permission-prompts');
    expect(seen.argv).toContain('--json-schema');
    expect(seen.argv).not.toContain('--dangerously-skip-permissions');
    expect(seen.argv).not.toContain('--max-turns');
  });

  it('maxTurns from options reaches argv', async () => {
    const a = adapter(
      { ...fixture('review-approve.jsonl'), STUB_REQUIRE_ARG: '--max-turns' },
      { maxTurns: 4 },
    );
    const events = await collect(a.start(input({ kind: 'review' })));
    expect(events.at(-1)?.type).toBe('run_completed');
    const without = adapter({
      ...fixture('review-approve.jsonl'),
      STUB_REQUIRE_ARG: '--max-turns',
    });
    expect(lastError(await collect(without.start(input({ kind: 'review' })))).code).toBe(
      'CLAUDE_EXITED_WITHOUT_RESULT',
    );
  });

  it('log never contains the prompt', async () => {
    const logs: string[] = [];
    const a = adapter(fixture('plan-success.jsonl'), { log: (l) => logs.push(l) });
    await collect(a.start(input({ prompt: 'PROMPT-BODY-SECRET' })));
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('PROMPT-BODY');
    expect(logs[0]).not.toContain('json-schema');
  });

  it('unsupported kinds fail without spawning', async () => {
    for (const kind of ['implement', 'revise'] as const) {
      const before = trackedChildCount();
      const events = await collect(adapter(fixture('plan-success.jsonl')).start(input({ kind })));
      expect(types(events)).toEqual(['usage_reported', 'run_failed']);
      expect(lastError(events).code).toBe('UNSUPPORTED_KIND');
      expect(trackedChildCount()).toBe(before);
    }
  });

  it('CLI error result → CLAUDE_ERROR', async () => {
    const events = await collect(adapter(fixture('cli-error.jsonl')).start(input()));
    expect(lastError(events)).toMatchObject({ code: 'CLAUDE_ERROR' });
    expect(terminals(events)).toHaveLength(1);
  });

  it('invalid structured output → AGENT_RESULT_INVALID', async () => {
    const events = await collect(adapter(fixture('invalid-result.jsonl')).start(input()));
    expect(lastError(events).code).toBe('AGENT_RESULT_INVALID');
  });

  it('no usage → single unavailable usage before completion', async () => {
    const events = await collect(adapter(fixture('no-usage.jsonl')).start(input()));
    const usages = events.filter((e) => e.type === 'usage_reported');
    expect(usages).toHaveLength(1);
    expect(usages[0]?.type === 'usage_reported' && usages[0].usage.source).toBe('unavailable');
    expect(types(events).indexOf('usage_reported')).toBeLessThan(
      types(events).indexOf('run_completed'),
    );
  });

  it('malformed / duplicate-terminal fixtures → exactly one terminal', async () => {
    const m = await collect(adapter(fixture('malformed.jsonl')).start(input()));
    expect(terminals(m)).toHaveLength(1);
    expect(m.at(-1)?.type).toBe('run_completed');
    const d = await collect(
      adapter(fixture('duplicate-terminal.jsonl')).start(input({ kind: 'review' })),
    );
    expect(terminals(d)).toHaveLength(1);
    expect(d.filter((e) => e.type === 'usage_reported')).toHaveLength(1);
  });

  it('non-zero exit without a result → CLAUDE_EXITED_WITHOUT_RESULT with stderr tail', async () => {
    const events = await collect(
      adapter({ STUB_EXIT_CODE: '2', STUB_STDERR: 'not logged in' }).start(input()),
    );
    expect(types(events)).toEqual(['usage_reported', 'run_failed']);
    expect(lastError(events).code).toBe('CLAUDE_EXITED_WITHOUT_RESULT');
    expect(lastError(events).message).toContain('not logged in');
  });

  it('spawn failure → SPAWN_FAILED', async () => {
    const a = new ClaudeCliAdapter({
      executable: join(projectRoot, 'no-such-claude'),
      clock: new FixedClock(),
      timeoutMs: 1000,
    });
    const events = await collect(a.start(input()));
    expect(lastError(events).code).toBe('SPAWN_FAILED');
  });

  it('project root outside → INVALID_PROJECT_ROOT without spawning', async () => {
    const events = await collect(
      adapter(fixture('plan-success.jsonl')).start(
        input({ projectRoot: join(projectRoot, 'missing') }),
      ),
    );
    expect(lastError(events).code).toBe('INVALID_PROJECT_ROOT');
  });

  it('timeout → TIMEOUT, child and controller cleaned up', async () => {
    const a = adapter({ STUB_HANG_MS: '10000' }, { timeoutMs: 100 });
    const events = await collect(a.start(input()));
    expect(lastError(events).code).toBe('TIMEOUT');
    expect(terminals(events)).toHaveLength(1);
    expect(a.activeRuns).toBe(0);
    expect(trackedChildCount()).toBe(0);
  });

  it('cancel(runId) → CANCELLED', async () => {
    const a = adapter({ STUB_HANG_MS: '10000' });
    const stream = a.start(input({ runId: asRunId('run-cancel') }));
    setTimeout(() => void a.cancel(asRunId('run-cancel')), 50);
    const events = await collect(stream);
    expect(lastError(events).code).toBe('CANCELLED');
    expect(a.activeRuns).toBe(0);
  });

  it('external AbortSignal → CANCELLED', async () => {
    const controller = new AbortController();
    const a = adapter({ STUB_HANG_MS: '10000' });
    setTimeout(() => controller.abort(), 50);
    const events = await collect(a.start(input({ signal: controller.signal })));
    expect(lastError(events).code).toBe('CANCELLED');
    expect(trackedChildCount()).toBe(0);
  });

  it('never references a real claude executable', () => {
    const a = adapter(fixture('plan-success.jsonl'));
    expect((a as unknown as { executable: string }).executable).toBe(process.execPath);
  });
});
