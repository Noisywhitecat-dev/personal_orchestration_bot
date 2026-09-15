import type { DatabaseSync } from 'node:sqlite';

import type { Repositories } from '../../application/repositories.js';
import type { Message, TaskEvent } from '../../domain/message.js';
import type { Project } from '../../domain/project.js';
import type { Run } from '../../domain/run.js';
import type { Task } from '../../domain/task.js';
import type { UsageRecord } from '../../domain/usage.js';

// Rows are mapped by hand; no ORM. JSON columns hold small structured fields.

type Row = Record<string, unknown>;

const str = (r: Row, k: string): string => r[k] as string;
const nul = <T>(r: Row, k: string): T | null =>
  r[k] === null || r[k] === undefined ? null : (r[k] as T);
const json = <T>(r: Row, k: string, fallback: T): T => {
  const v = r[k];
  return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
};

function rowToProject(r: Row): Project {
  return {
    id: str(r, 'id') as Project['id'],
    name: str(r, 'name'),
    rootPath: str(r, 'root_path'),
    createdAt: str(r, 'created_at'),
  };
}

function rowToTask(r: Row): Task {
  return {
    id: str(r, 'id') as Task['id'],
    projectId: str(r, 'project_id') as Task['projectId'],
    request: str(r, 'request'),
    state: str(r, 'state') as Task['state'],
    plan: json<Task['plan']>(r, 'plan_json', null),
    clarificationRound: r['clarification_round'] as number,
    maxClarificationRounds: r['max_clarification_rounds'] as number,
    reviewRound: r['review_round'] as number,
    maxReviewRounds: r['max_review_rounds'] as number,
    maxClaudeRuns: r['max_claude_runs'] as number,
    maxCodexRuns: r['max_codex_runs'] as number,
    claudeTokenCeiling: nul<number>(r, 'claude_token_ceiling'),
    codexTokenCeiling: nul<number>(r, 'codex_token_ceiling'),
    reviews: json<Task['reviews']>(r, 'reviews_json', []),
    codexSessionId: nul<Task['codexSessionId']>(r, 'codex_session_id') as Task['codexSessionId'],
    claudeSessionId: nul<Task['claudeSessionId']>(
      r,
      'claude_session_id',
    ) as Task['claudeSessionId'],
    failure: json<Task['failure']>(r, 'failure_json', null),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  };
}

function rowToRun(r: Row): Run {
  return {
    id: str(r, 'id') as Run['id'],
    taskId: str(r, 'task_id') as Run['taskId'],
    projectId: str(r, 'project_id') as Run['projectId'],
    provider: str(r, 'provider') as Run['provider'],
    kind: str(r, 'kind') as Run['kind'],
    status: str(r, 'status') as Run['status'],
    sessionId: nul<string>(r, 'session_id') as Run['sessionId'],
    startedAt: str(r, 'started_at'),
    finishedAt: nul<string>(r, 'finished_at'),
    error: json<Run['error']>(r, 'error_json', null),
  };
}

function rowToMessage(r: Row): Message {
  return {
    id: str(r, 'id') as Message['id'],
    projectId: str(r, 'project_id') as Message['projectId'],
    taskId: nul<string>(r, 'task_id') as Message['taskId'],
    role: str(r, 'role') as Message['role'],
    content: str(r, 'content'),
    createdAt: str(r, 'created_at'),
  };
}

function rowToUsage(r: Row): UsageRecord {
  return {
    id: str(r, 'id') as UsageRecord['id'],
    provider: str(r, 'provider') as UsageRecord['provider'],
    projectId: str(r, 'project_id') as UsageRecord['projectId'],
    taskId: str(r, 'task_id') as UsageRecord['taskId'],
    runId: str(r, 'run_id') as UsageRecord['runId'],
    sessionId: nul<string>(r, 'session_id') as UsageRecord['sessionId'],
    inputTokens: nul<number>(r, 'input_tokens'),
    cachedInputTokens: nul<number>(r, 'cached_input_tokens'),
    outputTokens: nul<number>(r, 'output_tokens'),
    reasoningTokens: nul<number>(r, 'reasoning_tokens'),
    totalTokens: nul<number>(r, 'total_tokens'),
    source: str(r, 'source') as UsageRecord['source'],
    recordedAt: str(r, 'recorded_at'),
  };
}

function rowToEvent(r: Row): TaskEvent {
  return {
    id: str(r, 'id') as TaskEvent['id'],
    taskId: str(r, 'task_id') as TaskEvent['taskId'],
    runId: nul<string>(r, 'run_id') as TaskEvent['runId'],
    type: str(r, 'type'),
    payload: json<Record<string, unknown>>(r, 'payload_json', {}),
    createdAt: str(r, 'created_at'),
  };
}

const j = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

export function createSqliteRepositories(db: DatabaseSync): Repositories {
  // Monotonic sequence for ordering rows that may share a timestamp.
  let seq =
    (
      db
        .prepare(
          'SELECT MAX(m) AS m FROM (SELECT MAX(seq) AS m FROM messages UNION SELECT MAX(seq) FROM task_events)',
        )
        .get() as { m: number | null }
    ).m ?? 0;
  const nextSeq = () => ++seq;

  const s = {
    insertProject: db.prepare(
      'INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
    ),
    projectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    projects: db.prepare('SELECT * FROM projects ORDER BY created_at, id'),

    insertTask:
      db.prepare(`INSERT INTO tasks (id, project_id, request, state, plan_json, clarification_round, max_clarification_rounds,
      review_round, max_review_rounds, max_claude_runs, max_codex_runs, claude_token_ceiling, codex_token_ceiling, reviews_json,
      codex_session_id, claude_session_id, failure_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTask:
      db.prepare(`UPDATE tasks SET state = ?, plan_json = ?, clarification_round = ?, max_clarification_rounds = ?,
      review_round = ?, max_review_rounds = ?, max_claude_runs = ?, max_codex_runs = ?, claude_token_ceiling = ?,
      codex_token_ceiling = ?, reviews_json = ?, codex_session_id = ?, claude_session_id = ?, failure_json = ?,
      updated_at = ? WHERE id = ?`),
    taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    tasksByProject: db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id'),
    tasksAll: db.prepare('SELECT * FROM tasks ORDER BY created_at, id'),

    insertRun:
      db.prepare(`INSERT INTO runs (id, task_id, project_id, provider, kind, status, session_id, started_at, finished_at, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateRun: db.prepare(
      'UPDATE runs SET status = ?, session_id = ?, finished_at = ?, error_json = ? WHERE id = ?',
    ),
    runById: db.prepare('SELECT * FROM runs WHERE id = ?'),
    runsByTask: db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, id'),

    insertMessage: db.prepare(
      'INSERT INTO messages (id, project_id, task_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    messagesByProject: db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY seq'),

    insertUsage:
      db.prepare(`INSERT INTO usage_records (id, provider, project_id, task_id, run_id, session_id, input_tokens, cached_input_tokens,
      output_tokens, reasoning_tokens, total_tokens, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    usageByTask: db.prepare(
      'SELECT * FROM usage_records WHERE task_id = ? ORDER BY recorded_at, id',
    ),
    usageByProject: db.prepare(
      'SELECT * FROM usage_records WHERE project_id = ? ORDER BY recorded_at, id',
    ),

    insertEvent: db.prepare(
      'INSERT INTO task_events (id, task_id, run_id, type, payload_json, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    eventsByTask: db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY seq'),
  };

  return {
    projects: {
      insert: (p) => void s.insertProject.run(p.id, p.name, p.rootPath, p.createdAt),
      findById: (id) => {
        const r = s.projectById.get(id) as Row | undefined;
        return r ? rowToProject(r) : null;
      },
      list: () => (s.projects.all() as Row[]).map(rowToProject),
    },
    tasks: {
      insert: (t) =>
        void s.insertTask.run(
          t.id,
          t.projectId,
          t.request,
          t.state,
          j(t.plan),
          t.clarificationRound,
          t.maxClarificationRounds,
          t.reviewRound,
          t.maxReviewRounds,
          t.maxClaudeRuns,
          t.maxCodexRuns,
          t.claudeTokenCeiling,
          t.codexTokenCeiling,
          JSON.stringify(t.reviews),
          t.codexSessionId,
          t.claudeSessionId,
          j(t.failure),
          t.createdAt,
          t.updatedAt,
        ),
      update: (t) => {
        const res = s.updateTask.run(
          t.state,
          j(t.plan),
          t.clarificationRound,
          t.maxClarificationRounds,
          t.reviewRound,
          t.maxReviewRounds,
          t.maxClaudeRuns,
          t.maxCodexRuns,
          t.claudeTokenCeiling,
          t.codexTokenCeiling,
          JSON.stringify(t.reviews),
          t.codexSessionId,
          t.claudeSessionId,
          j(t.failure),
          t.updatedAt,
          t.id,
        );
        if (res.changes === 0) throw new Error(`task ${t.id} not found`);
      },
      findById: (id) => {
        const r = s.taskById.get(id) as Row | undefined;
        return r ? rowToTask(r) : null;
      },
      listByProject: (pid) => (s.tasksByProject.all(pid) as Row[]).map(rowToTask),
      listAll: () => (s.tasksAll.all() as Row[]).map(rowToTask),
    },
    runs: {
      insert: (r) =>
        void s.insertRun.run(
          r.id,
          r.taskId,
          r.projectId,
          r.provider,
          r.kind,
          r.status,
          r.sessionId,
          r.startedAt,
          r.finishedAt,
          j(r.error),
        ),
      update: (r) => {
        const res = s.updateRun.run(r.status, r.sessionId, r.finishedAt, j(r.error), r.id);
        if (res.changes === 0) throw new Error(`run ${r.id} not found`);
      },
      findById: (id) => {
        const r = s.runById.get(id) as Row | undefined;
        return r ? rowToRun(r) : null;
      },
      listByTask: (tid) => (s.runsByTask.all(tid) as Row[]).map(rowToRun),
    },
    messages: {
      insert: (m) =>
        void s.insertMessage.run(
          m.id,
          m.projectId,
          m.taskId,
          m.role,
          m.content,
          m.createdAt,
          nextSeq(),
        ),
      listByProject: (pid) => (s.messagesByProject.all(pid) as Row[]).map(rowToMessage),
    },
    usage: {
      insert: (u) =>
        void s.insertUsage.run(
          u.id,
          u.provider,
          u.projectId,
          u.taskId,
          u.runId,
          u.sessionId,
          u.inputTokens,
          u.cachedInputTokens,
          u.outputTokens,
          u.reasoningTokens,
          u.totalTokens,
          u.source,
          u.recordedAt,
        ),
      listByTask: (tid) => (s.usageByTask.all(tid) as Row[]).map(rowToUsage),
      listByProject: (pid) => (s.usageByProject.all(pid) as Row[]).map(rowToUsage),
    },
    taskEvents: {
      insert: (e) =>
        void s.insertEvent.run(
          e.id,
          e.taskId,
          e.runId,
          e.type,
          JSON.stringify(e.payload),
          e.createdAt,
          nextSeq(),
        ),
      listByTask: (tid) => (s.eventsByTask.all(tid) as Row[]).map(rowToEvent),
    },
  };
}
