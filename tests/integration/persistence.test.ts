import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    expect(migrate(db)).toBe(2);
    expect(migrate(db)).toBe(2);
    db.close();
  });

  it('migrates a v1 task table without deleting existing data', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
        plan_json TEXT, review_round INTEGER NOT NULL DEFAULT 0, max_review_rounds INTEGER NOT NULL,
        reviews_json TEXT NOT NULL DEFAULT '[]', codex_session_id TEXT, claude_session_id TEXT,
        failure_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
      INSERT INTO projects VALUES ('p', 'old', 'D:/old', '2026-01-01');
      INSERT INTO tasks VALUES ('t', 'p', 'old request', 'awaiting_approval', NULL, 0, 2, '[]', NULL, NULL, NULL, '2026-01-01', '2026-01-01');
    `);
    expect(migrate(db)).toBe(2);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t') as Record<string, unknown>;
    expect(row['request']).toBe('old request');
    expect(row['clarification_round']).toBe(0);
    expect(row['max_clarification_rounds']).toBe(3);
    expect(row['max_claude_runs']).toBe(6);
    expect(row['max_codex_runs']).toBe(3);
    expect(row['claude_token_ceiling']).toBeNull();
    db.close();
  });

  it('round-trips all entities through a completed task', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Add a button', {
      maxClaudeRuns: 9,
      maxCodexRuns: 4,
      claudeTokenCeiling: 5000,
      codexTokenCeiling: null,
      maxClarificationRounds: 4,
      maxReviewRounds: 3,
    });
    await a.orchestrator.whenSettled(task.id);
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
    expect(before.task).toMatchObject({
      maxClaudeRuns: 9,
      maxCodexRuns: 4,
      claudeTokenCeiling: 5000,
      maxClarificationRounds: 4,
      maxReviewRounds: 3,
    });
    b.db.close();
  });

  it('restores an awaiting clarification and resumes it after restart', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Need details [fake-clarify:1]');
    await a.orchestrator.whenSettled(task.id);
    expect(a.orchestrator.getTask(task.id).state).toBe('awaiting_clarification');
    a.db.close();

    const b = boot(path, 'b');
    expect(b.orchestrator.recoverInterrupted()).toEqual({ restarted: [], failed: [] });
    expect(b.orchestrator.getTask(task.id).state).toBe('awaiting_clarification');
    b.orchestrator.answerClarification(task.id, 'Use node:test');
    await b.orchestrator.whenSettled(task.id);
    expect(b.orchestrator.getTask(task.id).state).toBe('awaiting_approval');
    const runs = b.orchestrator.listRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.sessionId).toBe(runs[1]?.sessionId);
    b.db.close();
  });

  it('fails a clarification resume that was in flight when the server restarted', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Need details [fake-clarify:1]');
    await a.orchestrator.whenSettled(task.id);
    a.orchestrator.answerClarification(task.id, 'Use node:test');
    await a.orchestrator.whenSettled(task.id);
    // Recreate the durable shape left by a process exit during the resumed planning call.
    a.db.prepare("UPDATE tasks SET state = 'draft', plan_json = NULL WHERE id = ?").run(task.id);
    a.db
      .prepare(
        "UPDATE runs SET status = 'running', finished_at = NULL WHERE task_id = ? AND kind = 'plan' AND started_at = (SELECT MAX(started_at) FROM runs WHERE task_id = ?)",
      )
      .run(task.id, task.id);
    a.db.close();

    const b = boot(path, 'b');
    expect(b.orchestrator.recoverInterrupted()).toEqual({ restarted: [], failed: [task.id] });
    expect(b.orchestrator.getTask(task.id)).toMatchObject({
      state: 'failed',
      clarificationRound: 1,
      failure: { code: 'INTERRUPTED' },
    });
    const runs = b.orchestrator.listRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs.at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERRUPTED' },
    });
    b.db.close();
  });

  it('restores awaiting_approval and continues after restart', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const draft = await a.orchestrator.submitRequest(project.id, 'Add a button');
    expect(draft.state).toBe('draft');
    await a.orchestrator.whenSettled(draft.id);
    const task = a.orchestrator.getTask(draft.id);
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

  it('fails a draft whose plan run was interrupted, closing the run, and keeps awaiting_approval', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const ready = await a.orchestrator.submitRequest(project.id, 'ready one');
    await a.orchestrator.whenSettled(ready.id);
    const draft = await a.orchestrator.submitRequest(project.id, 'interrupted one');
    await a.orchestrator.whenSettled(draft.id);
    // Rewind the second task to how a crash mid-planning leaves it on disk.
    a.db.prepare("UPDATE tasks SET state = 'draft', plan_json = NULL WHERE id = ?").run(draft.id);
    a.db
      .prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE task_id = ?")
      .run(draft.id);
    a.db.close();

    const b = boot(path, 'b');
    const recovery = b.orchestrator.recoverInterrupted();
    expect(recovery).toEqual({ restarted: [], failed: [draft.id] });
    const t = b.orchestrator.getTask(draft.id);
    expect(t.state).toBe('failed');
    expect(t.failure?.code).toBe('INTERRUPTED');
    const run = b.orchestrator.listRuns(draft.id)[0];
    expect(run?.status).toBe('failed');
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.error?.code).toBe('INTERRUPTED');
    expect(b.orchestrator.getTask(ready.id).state).toBe('awaiting_approval');
    b.db.close();
  });

  it('fails a task that was implementing when the process died', async () => {
    const path = tempDbPath();
    const a = boot(path, 'a');
    const project = a.orchestrator.registerProject('demo', 'D:/fake/demo');
    const task = await a.orchestrator.submitRequest(project.id, 'Add a button');
    await a.orchestrator.whenSettled(task.id);
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
