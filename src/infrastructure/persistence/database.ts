import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Version-based migrations. Append new entries; never edit shipped ones.
 * `user_version` pragma tracks the applied version.
 */
const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    request TEXT NOT NULL,
    state TEXT NOT NULL,
    plan_json TEXT,
    review_round INTEGER NOT NULL DEFAULT 0,
    max_review_rounds INTEGER NOT NULL,
    reviews_json TEXT NOT NULL DEFAULT '[]',
    codex_session_id TEXT,
    claude_session_id TEXT,
    failure_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project_idx ON tasks(project_id, created_at);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_json TEXT
  );
  CREATE INDEX runs_task_idx ON runs(task_id, started_at);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    task_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seq INTEGER NOT NULL
  );
  CREATE INDEX messages_project_idx ON messages(project_id, seq);
  CREATE TABLE usage_records (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    session_id TEXT,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX usage_task_idx ON usage_records(task_id);
  CREATE INDEX usage_project_idx ON usage_records(project_id);
  CREATE TABLE task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seq INTEGER NOT NULL
  );
  CREATE INDEX task_events_task_idx ON task_events(task_id, seq);
  `,
  // v2 — M15 persisted clarification progress and per-task execution limits.
  `
  ALTER TABLE tasks ADD COLUMN clarification_round INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN max_clarification_rounds INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE tasks ADD COLUMN max_claude_runs INTEGER NOT NULL DEFAULT 6;
  ALTER TABLE tasks ADD COLUMN max_codex_runs INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE tasks ADD COLUMN claude_token_ceiling INTEGER;
  ALTER TABLE tasks ADD COLUMN codex_token_ceiling INTEGER;
  `,
  // v3 — command output may contain source, diffs, paths, or credentials. Keep only metadata.
  `
  UPDATE task_events
  SET payload_json = json_remove(payload_json, '$.stdoutTail', '$.stderrTail')
  WHERE type = 'command_completed' AND json_valid(payload_json);
  `,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  const needsCommandOutputPurge = version < 3;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) break;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version += 1;
  }
  if (needsCommandOutputPurge && version >= 3) {
    // v3 removes potentially sensitive command tails. Compact once so old cell bytes and WAL pages
    // cannot retain the removed text in the database file.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  return version;
}
