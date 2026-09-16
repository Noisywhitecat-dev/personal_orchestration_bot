import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../../src/application/orchestrator.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { createInMemoryRepositories } from '../../src/infrastructure/persistence/in-memory-repositories.js';
import { createSqliteRepositories } from '../../src/infrastructure/persistence/sqlite-repositories.js';
import { openDatabase } from '../../src/infrastructure/persistence/database.js';
import { startApplicationServer } from '../../src/server/bootstrap.js';
import { asTaskId } from '../../src/domain/ids.js';
import { toPublicEvent } from '../../src/shared/contracts.js';

describe.each(['memory', 'sqlite'])('history deletion (%s)', (storage) => {
  it('rejects active/waiting tasks, atomically deletes only one terminal history and publishes a public event', async () => {
    const db = openDatabase(':memory:');
    const repos =
      storage === 'sqlite' ? createSqliteRepositories(db) : createInMemoryRepositories();
    const clock = new FixedClock();
    const ids = new SequentialIdGenerator();
    const app = new Orchestrator({
      clock,
      ids,
      repos,
      claude: new FakeClaudeAdapter(clock, ids),
      codex: new FakeCodexAdapter(clock, ids),
    });
    try {
      const project = app.registerProject('test', process.cwd());
      const otherProject = app.registerProject('other', process.cwd());
      const first = await app.submitRequest(project.id, 'first request');
      expect(() => app.deleteTaskHistory(first.id)).toThrow();
      await app.whenSettled(first.id);
      expect(() => app.deleteTaskHistory(first.id)).toThrow();
      app.approve(first.id);
      await app.whenSettled(first.id);
      const keep = await app.submitRequest(project.id, 'keep request');
      await app.whenSettled(keep.id);
      const other = await app.submitRequest(otherProject.id, 'other request');
      await app.whenSettled(other.id);
      const keepMessages = app.listMessages(project.id).filter((m) => m.taskId === keep.id);
      expect(app.listRuns(first.id).length).toBeGreaterThan(0);
      expect(app.listTimeline(first.id).length).toBeGreaterThan(0);
      expect(repos.usage.listByTask(first.id).length).toBeGreaterThan(0);
      if (storage === 'sqlite') {
        db.exec(
          "CREATE TRIGGER prevent_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
        );
        expect(() => app.deleteTaskHistory(first.id)).toThrow('test rollback');
        expect(app.listRuns(first.id).length).toBeGreaterThan(0);
        expect(app.listMessages(project.id).some((m) => m.taskId === first.id)).toBe(true);
        expect(repos.usage.listByTask(first.id).length).toBeGreaterThan(0);
        db.exec('DROP TRIGGER prevent_delete');
      }
      const events: unknown[] = [];
      app.bus.subscribe((e) => events.push(toPublicEvent(e)));
      app.deleteTaskHistory(first.id);
      expect(() => app.getTask(first.id)).toThrow();
      expect(app.listRuns(first.id)).toEqual([]);
      expect(app.listTimeline(first.id)).toEqual([]);
      expect(repos.usage.listByTask(first.id)).toEqual([]);
      expect(app.listMessages(project.id)).toEqual(keepMessages);
      expect(app.listTasks(project.id).map((t) => t.id)).toEqual([keep.id]);
      expect(app.getTask(other.id).projectId).toBe(otherProject.id);
      expect(app.listProjects()).toHaveLength(2);
      expect(events).toEqual([{ type: 'task_deleted', taskId: first.id, projectId: project.id }]);
      expect(() => app.deleteTaskHistory(first.id)).toThrow();
      app.reject(keep.id);
      app.deleteTaskHistory(keep.id);
      expect(app.listTasks(project.id)).toEqual([]);
    } finally {
      await app.shutdown();
      db.close();
    }
  });
});

it('HTTP deletion requires explicit confirmation and same origin, and disappears after delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-delete-'));
  const server = await startApplicationServer({
    port: 0,
    databasePath: join(dir, 'test.db'),
    env: { CLAUDE_ADAPTER: 'fake', CODEX_ADAPTER: 'fake' },
    log: () => {},
  });
  const post = (path: string, body: unknown, origin = server.url) =>
    fetch(server.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    });
  try {
    const created = (await (
      await post('/api/projects', { name: 'temporary', rootPath: process.cwd() })
    ).json()) as { project: { id: string } };
    const response = await post('/api/requests', {
      projectId: created.project.id,
      request: 'fake request',
    });
    const { task } = (await response.json()) as { task: { id: string } };
    expect((await post('/api/tasks/' + task.id + '/delete', { confirm: true })).status).toBe(409);
    await post('/api/tasks/' + task.id + '/cancel', {});
    const path = '/api/tasks/' + task.id + '/delete';
    expect((await post(path, {})).status).toBe(400);
    expect((await post(path, { confirm: false })).status).toBe(400);
    expect((await post(path, { confirm: true }, 'https://untrusted.example')).status).toBe(403);
    expect((await post(path, { confirm: true })).status).toBe(200);
    expect((await fetch(server.url + '/api/tasks/' + asTaskId(task.id))).status).toBe(404);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
