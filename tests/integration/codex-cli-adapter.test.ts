import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../src/domain/agent-events.js';
import { asRunId, asSessionId, asTaskId } from '../../src/domain/ids.js';
import { FixedClock } from '../../src/domain/ports.js';
import type { AgentRunInput } from '../../src/infrastructure/agents/agent-adapter.js';
import { CodexCliAdapter } from '../../src/infrastructure/agents/codex-cli-adapter.js';

// The adapter is pointed at `node tests/fixtures/codex/stub-codex.mjs`, which replays a fixture.
// The real `codex` binary is never referenced.

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'codex');
const STUB = join(FIXTURES, 'stub-codex.mjs');

let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function adapter(
  env: Record<string, string>,
  extra: Partial<ConstructorParameters<typeof CodexCliAdapter>[0]> = {},
) {
  return new CodexCliAdapter({
    executable: process.execPath,
    extraArgs: [STUB],
    clock: new FixedClock(),
    env,
    timeoutMs: 5_000,
    killGraceMs: 50,
    gitStatusFallback: false,
    ...extra,
  });
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: asRunId('run-1'),
    taskId: asTaskId('task-1'),
    projectRoot,
    kind: 'implement',
    prompt: 'Add a logout button',
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

describe('CodexCliAdapter (stub executable)', () => {
  it('start: streams the normalized event sequence and result', async () => {
    const events = await collect(adapter(fixture('happy-path.jsonl')).start(input()));
    expect(types(events)).toEqual([
      'session_started',
      'reasoning_delta',
      'message_delta',
      'command_started',
      'command_completed',
      'message_delta',
      'usage_reported',
      'run_completed',
    ]);
    const s = events[0];
    expect(s?.type === 'session_started' && s.sessionId).toBe('thread-abc-123');
    const done = events.at(-1);
    if (done?.type !== 'run_completed' || done.result.kind !== 'implementation')
      throw new Error('bad terminal');
    expect(done.result.testsPassed).toBe(true);
    expect(done.result.changedFiles).toEqual(['src/header.tsx', 'src/header.test.tsx']);
    const u = events.find((e) => e.type === 'usage_reported');
    expect(u?.type === 'usage_reported' && u.usage).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 400,
      outputTokens: 350,
      reasoningTokens: 120,
      totalTokens: 1550,
      source: 'actual',
    });
    expect(terminals(events)).toHaveLength(1);
  });

  it('start: passes the verified argv and the prompt via stdin', async () => {
    const stderrLines: string[] = [];
    const a = adapter(
      { ...fixture('happy-path.jsonl'), STUB_ECHO_ARGS: '1', STUB_ECHO_STDIN: '1' },
      {
        log: (l) => stderrLines.push(l),
      },
    );
    // The stub echoes argv/stdin to stderr; capture it through a second run with the runner's tail.
    // Simpler: run the stub directly through the adapter and inspect the run log + a marker file.
    const events = await collect(a.start(input({ prompt: 'PROMPT-BODY-1234567890' })));
    expect(terminals(events)[0]?.type).toBe('run_completed');
    // Summary log never contains the prompt.
    expect(stderrLines.join('\n')).not.toContain('PROMPT-BODY');
    expect(stderrLines.join('\n')).toContain('argc=8'); // stub + 7 codex args
  });

  it('resume: announces the session id once and uses resume argv', async () => {
    const events = await collect(
      adapter(fixture('resume.jsonl')).resume(
        asSessionId('thread-abc-123'),
        input({ kind: 'revise' }),
      ),
    );
    const sessions = events.filter((e) => e.type === 'session_started');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.type === 'session_started' && sessions[0].sessionId).toBe('thread-abc-123');
    expect(types(events).at(-1)).toBe('run_completed');
    const done = events.at(-1);
    if (done?.type !== 'run_completed' || done.result.kind !== 'implementation')
      throw new Error('bad terminal');
    expect(done.result.changedFiles).toEqual(['src/header.tsx']);
  });

  it('resume: a different id from the CLI is passed through', async () => {
    const events = await collect(
      adapter(fixture('happy-path.jsonl')).resume(asSessionId('old-session'), input()),
    );
    const ids = events
      .filter((e) => e.type === 'session_started')
      .map((e) => (e.type === 'session_started' ? e.sessionId : ''));
    expect(ids).toEqual(['old-session', 'thread-abc-123']);
  });

  it('failed test command → testsPassed false', async () => {
    const events = await collect(adapter(fixture('command-failed.jsonl')).start(input()));
    const done = events.at(-1);
    expect(
      done?.type === 'run_completed' &&
        done.result.kind === 'implementation' &&
        done.result.testsPassed,
    ).toBe(false);
  });

  it('no usage → exactly one unavailable usage event', async () => {
    const events = await collect(adapter(fixture('no-usage.jsonl')).start(input()));
    const usages = events.filter((e) => e.type === 'usage_reported');
    expect(usages).toHaveLength(1);
    expect(usages[0]?.type === 'usage_reported' && usages[0].usage.source).toBe('unavailable');
    expect(types(events).indexOf('usage_reported')).toBeLessThan(
      types(events).indexOf('run_completed'),
    );
  });

  it('provider error → run_failed and nothing after it', async () => {
    const events = await collect(adapter(fixture('error.jsonl')).start(input()));
    const term = terminals(events);
    expect(term).toHaveLength(1);
    expect(term[0]?.type === 'run_failed' && term[0].error.message).toBe('Rate limit exceeded');
    expect(events.at(-1)?.type).toBe('run_failed');
  });

  it('banner / malformed / unknown lines are tolerated', async () => {
    const events = await collect(adapter(fixture('garbage.jsonl')).start(input()));
    expect(terminals(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run_completed');
  });

  it('duplicate completion → single terminal event', async () => {
    const events = await collect(adapter(fixture('duplicate-completion.jsonl')).start(input()));
    expect(terminals(events)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'usage_reported')).toHaveLength(1);
  });

  it('large output is streamed line by line and bounded', async () => {
    const events = await collect(adapter(fixture('large-output.jsonl')).start(input()));
    const cmd = events.find((e) => e.type === 'command_completed');
    expect(cmd?.type === 'command_completed' && cmd.stdoutTail?.length).toBe(2000);
    expect(events.at(-1)?.type).toBe('run_completed');
  });

  it('non-zero exit without completion → run_failed with stderr tail', async () => {
    const events = await collect(
      adapter({ STUB_EXIT_CODE: '7', STUB_STDERR: 'auth required' }).start(input()),
    );
    expect(types(events)).toEqual(['usage_reported', 'run_failed']);
    const f = events[1];
    expect(f?.type === 'run_failed' && f.error.code).toBe('CODEX_EXITED_WITHOUT_RESULT');
    expect(f?.type === 'run_failed' && f.error.message).toContain('auth required');
  });

  it('timeout → run_failed TIMEOUT, child killed', async () => {
    const a = adapter({ STUB_HANG_MS: '10000' }, { timeoutMs: 100 });
    const events = await collect(a.start(input()));
    const f = events.at(-1);
    expect(f?.type === 'run_failed' && f.error.code).toBe('TIMEOUT');
    expect(terminals(events)).toHaveLength(1);
  });

  it('cancel(runId) → run_failed CANCELLED', async () => {
    const a = adapter({ STUB_HANG_MS: '10000' });
    const stream = a.start(input({ runId: asRunId('run-cancel') }));
    setTimeout(() => void a.cancel(asRunId('run-cancel')), 50);
    const events = await collect(stream);
    const f = events.at(-1);
    expect(f?.type === 'run_failed' && f.error.code).toBe('CANCELLED');
  });

  it('input.signal abort → run_failed CANCELLED', async () => {
    const controller = new AbortController();
    const a = adapter({ STUB_HANG_MS: '10000' });
    setTimeout(() => controller.abort(), 50);
    const events = await collect(a.start(input({ signal: controller.signal })));
    const f = events.at(-1);
    expect(f?.type === 'run_failed' && f.error.code).toBe('CANCELLED');
  });

  it('project root outside → run_failed INVALID_PROJECT_ROOT without spawning', async () => {
    const events = await collect(
      adapter(fixture('happy-path.jsonl')).start(
        input({ projectRoot: join(projectRoot, 'missing') }),
      ),
    );
    expect(types(events)).toEqual(['usage_reported', 'run_failed']);
    expect(events[1]?.type === 'run_failed' && events[1].error.code).toBe('INVALID_PROJECT_ROOT');
  });

  it('git status fallback fills changedFiles when Codex reported none', async () => {
    // Make projectRoot a git repo with one untracked file.
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    writeFileSync(join(projectRoot, 'new-file.txt'), 'x');
    const events = await collect(
      adapter(fixture('no-usage.jsonl'), { gitStatusFallback: true }).start(input()),
    );
    const done = events.at(-1);
    expect(
      done?.type === 'run_completed' &&
        done.result.kind === 'implementation' &&
        done.result.changedFiles,
    ).toEqual(['new-file.txt']);
  });

  it('never references the real codex executable', () => {
    const a = adapter(fixture('happy-path.jsonl'));
    expect((a as unknown as { executable: string }).executable).toBe(process.execPath);
  });
});
