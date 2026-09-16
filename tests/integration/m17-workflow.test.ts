import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../../src/application/orchestrator.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import type { AgentEvent } from '../../src/domain/agent-events.js';
import type { AgentAdapter, AgentRunInput } from '../../src/infrastructure/agents/agent-adapter.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { openDatabase } from '../../src/infrastructure/persistence/database.js';
import { createSqliteRepositories } from '../../src/infrastructure/persistence/sqlite-repositories.js';
import { toPublicEvent } from '../../src/shared/contracts.js';
import { startApplicationServer } from '../../src/server/bootstrap.js';
import { RecordingAdapter } from '../helpers/recording-adapter.js';
import { GatedAdapter } from '../helpers/gated-adapter.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-m17-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const secret = 'RAW_PRIVATE_OUTPUT_9aa47';
function noisy(adapter: AgentAdapter, fail = false): AgentAdapter {
  async function* wrap(
    input: AgentRunInput,
    stream: AsyncIterable<AgentEvent>,
  ): AsyncGenerator<AgentEvent> {
    const base = { runId: input.runId, timestamp: '2026-09-16T00:00:00Z' };
    yield { ...base, type: 'message_delta', text: secret + input.prompt };
    yield { ...base, type: 'command_started', commandId: 'cmd', command: [secret], cwd: secret };
    yield {
      ...base,
      type: 'command_completed',
      commandId: 'cmd',
      exitCode: 0,
      stdoutTail: secret,
      stderrTail: secret,
    };
    if (fail) {
      yield { ...base, type: 'run_failed', error: { code: secret, message: secret } };
      return;
    }
    yield* stream;
  }
  return {
    provider: adapter.provider,
    start: (input) => wrap(input, adapter.start(input)),
    resume: (session, input) => wrap(input, adapter.resume(session, input)),
    cancel: (id) => adapter.cancel(id),
  };
}
function setup(path: string, fail = false, prefix = 'id') {
  const db = openDatabase(path);
  const repos = createSqliteRepositories(db);
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator(prefix);
  const claude = new RecordingAdapter(noisy(new FakeClaudeAdapter(clock, ids), fail));
  const codex = new RecordingAdapter(noisy(new FakeCodexAdapter(clock, ids)));
  const app = new Orchestrator({ clock, ids, repos, claude, codex });
  return { db, repos, app, claude, codex };
}

describe('M17 persistence, privacy and recovery', () => {
  it('executes a persisted legacy plan with no new fields', async () => {
    const path = join(temp(), 'legacy.db');
    const s = setup(path);
    const project = s.app.registerProject('legacy', temp());
    const task = await s.app.submitRequest(project.id, 'legacy request');
    await s.app.whenSettled(task.id);
    const legacy = { title: 'old plan', summary: 'old summary', steps: ['old step'] };
    s.repos.tasks.update({ ...s.app.getTask(task.id), plan: legacy });
    s.db.close();
    const reopened = setup(path, false, 'reopened');
    expect(reopened.app.getTask(task.id).plan).toEqual(legacy);
    reopened.app.approve(task.id);
    await reopened.app.whenSettled(task.id);
    expect(reopened.app.getTask(task.id).state).toBe('completed');
    expect(reopened.codex.prompts('implement')[0]).toContain('legacy request');
    reopened.db.close();
  });
  it('completes Fake clarification/revision with exact sessions, persists extended plans and no raw CLI text', async () => {
    const path = join(temp(), 'test.db');
    const s = setup(path);
    const events: unknown[] = [];
    s.app.bus.subscribe((e) => events.push(toPublicEvent(e)));
    const project = s.app.registerProject('test', temp());
    const task = await s.app.submitRequest(project.id, 'page [fake-clarify:1] [fake-changes:1]');
    await s.app.whenSettled(task.id);
    expect(s.app.getTask(task.id).state).toBe('awaiting_clarification');
    s.app.answerClarification(task.id, 'small page');
    await s.app.whenSettled(task.id);
    const session = s.app.getTask(task.id).claudeSessionId;
    s.app.approve(task.id);
    await s.app.whenSettled(task.id);
    const result = s.app.getTask(task.id);
    expect(result.state).toBe('completed');
    expect(result.reviewRound).toBe(2);
    expect(result.claudeSessionId).toBe(session);
    expect(s.claude.resumedSessions.every((id) => id === session)).toBe(true);
    expect(s.codex.resumedSessions).toEqual([result.codexSessionId]);
    expect(result.plan?.acceptanceCriteria).toHaveLength(1);
    expect(result.plan?.riskLevel).toBe('low');
    expect(s.claude.prompts('plan')[1]).not.toContain(task.request);
    expect(s.codex.prompts('revise')[0]).not.toContain(task.request);
    const stored = JSON.stringify([
      s.app.listTimeline(task.id),
      s.app.listRuns(task.id),
      s.app.listMessages(project.id),
      events,
    ]);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('BEGIN_UNTRUSTED_REQUEST');
    s.db.close();
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
    const reopened = openDatabase(path);
    expect(createSqliteRepositories(reopened).tasks.findById(task.id)?.plan).toEqual(result.plan);
    reopened.close();
  });
  it('redacts provider failures before DB, messages and public events', async () => {
    const path = join(temp(), 'test.db');
    const s = setup(path, true);
    const project = s.app.registerProject('test', temp());
    const task = await s.app.submitRequest(project.id, 'a request');
    await s.app.whenSettled(task.id);
    expect(s.app.getTask(task.id).failure?.code).toBe('AGENT_RUN_FAILED');
    s.db.close();
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  });
  it('recovers every pending automatic stage without any provider call or changed transition rules', async () => {
    for (const state of [
      'queued',
      'review_requested',
      'changes_requested',
      'draft',
      'implementing',
      'reviewing',
    ] as const) {
      const s = setup(':memory:');
      const project = s.app.registerProject('test', temp());
      const task = await s.app.submitRequest(project.id, 'request');
      await s.app.whenSettled(task.id);
      const calls = s.claude.inputs.length + s.codex.inputs.length;
      s.repos.tasks.update({ ...s.app.getTask(task.id), state });
      const result = s.app.recoverInterrupted();
      await s.app.whenSettled(task.id);
      expect(result.restarted).toEqual([]);
      expect(result.failed).toEqual([task.id]);
      expect(s.app.getTask(task.id).failure?.code).toBe('INTERRUPTED');
      expect(s.claude.inputs.length + s.codex.inputs.length).toBe(calls);
      s.db.close();
    }
  });
  it('aborts and drains active runs before shutdown and leaves no automatic retry', async () => {
    const db = openDatabase(':memory:');
    const clock = new FixedClock();
    const ids = new SequentialIdGenerator();
    const claude = new GatedAdapter(new FakeClaudeAdapter(clock, ids), ['plan']);
    const app = new Orchestrator({
      clock,
      ids,
      repos: createSqliteRepositories(db),
      claude,
      codex: new FakeCodexAdapter(clock, ids),
    });
    const project = app.registerProject('test', temp());
    const task = await app.submitRequest(project.id, 'slow');
    await app.shutdown();
    expect(app.getTask(task.id).failure?.code).toBe('INTERRUPTED');
    expect(claude.pending).toBe(0);
    await expect(app.submitRequest(project.id, 'new')).rejects.toThrow();
    db.close();
  });
});

describe('harness HTTP authorization', () => {
  it('requires a registered ID, explicit confirmation, strict body and same-origin browser write', async () => {
    const root = temp();
    const server = await startApplicationServer({
      port: 0,
      databasePath: join(root, 'test.db'),
      env: {},
      log: () => undefined,
    });
    const post = (path: string, body: unknown, origin?: string) =>
      fetch(server.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });
    try {
      const registered = (await (
        await post('/api/projects', { name: 'test', rootPath: root })
      ).json()) as { project: { id: string } };
      const route = `/api/projects/${registered.project.id}/harness`;
      expect((await post(route, {})).status).toBe(400);
      expect((await post(route, { confirm: true, rootPath: tmpdir() })).status).toBe(400);
      expect((await post(route, { confirm: true }, 'https://example.invalid')).status).toBe(403);
      expect((await post('/api/projects/unknown/harness', { confirm: true })).status).toBe(404);
      const preview = (await (await fetch(server.url + route)).json()) as {
        files: { state: string }[];
      };
      expect(preview.files.every((f) => f.state === 'missing')).toBe(true);
      expect((await post(route, { confirm: true }, server.url)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
