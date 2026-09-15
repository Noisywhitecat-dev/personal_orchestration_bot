import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Orchestrator } from '../../src/application/orchestrator.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { migrate, openDatabase } from '../../src/infrastructure/persistence/database.js';
import { createSqliteRepositories } from '../../src/infrastructure/persistence/sqlite-repositories.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  dirs.push(dir);
  return join(dir, 'test.db');
}

function boot(dbPath: string, idPrefix: string) {
  const db = openDatabase(dbPath);
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator(idPrefix);
  const orchestrator = new Orchestrator({
    clock,
    ids,
    claude: new FakeClaudeAdapter(clock, ids),
    codex: new FakeCodexAdapter(clock, ids),
    repos: createSqliteRepositories(db),
  });
  return { db, orchestrator };
}

describe('SQLite persistence', () => {
  it('migrations are idempotent', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toBe(1);
    expect(migrate(db)).toBe(1);
    db.close();
  });

  it('round-trips all entities through a completed task', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Add a button');
    a.orchestrator.approve(task.id);
    await a.orchestrator.whenSettled(task.id);
    const before = {
      task: a.orchestrator.getTask(task.id),
      runs: a.orchestrator.listRuns(task.id),
      messages: a.orchestrator.listMessages(project.id),
      timeline: a.orchestrator.listTimeline(task.id),
      usage: a.orchestrator.taskUsage(task.id),
    };
    a.db.close();

    // "Restart": new process, same file.
    const b = boot(path, 'b');
    expect(b.orchestrator.listProjects()).toEqual([project]);
    expect(b.orchestrator.getTask(task.id)).toEqual(before.task);
    expect(b.orchestrator.listRuns(task.id)).toEqual(before.runs);
    expect(b.orchestrator.listMessages(project.id)).toEqual(before.messages);
    expect(b.orchestrator.listTimeline(task.id)).toEqual(before.timeline);
    expect(b.orchestrator.taskUsage(task.id)).toEqual(before.usage);
    expect(before.task.state).toBe('completed');
    b.db.close();
  });

  it('restores awaiting_approval and continues after restart', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Add a button');
    expect(task.state).toBe('awaiting_approval');
    a.db.close();

    const b = boot(path, 'b');
    const recovery = b.orchestrator.recoverInterrupted();
    expect(recovery).toEqual({ restarted: [], failed: [] });
    const restored = b.orchestrator.getTask(task.id);
    expect(restored.state).toBe('awaiting_approval');
    expect(restored.plan).toEqual(task.plan);

    b.orchestrator.approve(task.id);
    await b.orchestrator.whenSettled(task.id);
    expect(b.orchestrator.getTask(task.id).state).toBe('completed');
    // Plan usage from process A + review usage from process B are both present.
    expect(b.orchestrator.taskUsage(task.id).claude.recordCount).toBe(2);
    b.db.close();
  });

  it('fails a task that was implementing when the process died', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Add a button');
    // Simulate crash mid-implementation by writing the state directly.
    a.db.prepare("UPDATE tasks SET state = 'implementing' WHERE id = ?").run(task.id);
    a.db.close();

    const b = boot(path, 'b');
    const recovery = b.orchestrator.recoverInterrupted();
    expect(recovery.failed).toEqual([task.id]);
    const t = b.orchestrator.getTask(task.id);
    expect(t.state).toBe('failed');
    expect(t.failure?.code).toBe('INTERRUPTED');
    b.db.close();
  });
});
