import { useCallback, useEffect, useState } from 'react';

import type {
  ExecutionBudgetStatus,
  ExecutionLimitsInput,
  Message,
  Project,
  Run,
  RuntimeStatusResponse,
  SseEvent,
  Task,
  TaskEvent,
  UsageSummary,
} from '../../shared/contracts.js';
import { api } from '../api.js';
import { UsageTable } from '../components/UsageTable.js';
import { useEvents } from '../hooks/useEvents.js';
import { nextAction, tokenRangeLabel } from '../view-model.js';

const EMPTY_USAGE: UsageSummary = {
  claude: {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    recordCount: 0,
    hasEstimated: false,
    hasUnavailable: false,
  },
  codex: {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    recordCount: 0,
    hasEstimated: false,
    hasUnavailable: false,
  },
};

const EMPTY_BUDGET: ExecutionBudgetStatus = {
  claude: {
    maxRuns: 0,
    usedRuns: 0,
    remainingRuns: 0,
    tokenCeiling: null,
    knownTokens: 0,
    reliableRemainingTokens: null,
    tokenConfidence: 'unlimited',
  },
  codex: {
    maxRuns: 0,
    usedRuns: 0,
    remainingRuns: 0,
    tokenCeiling: null,
    knownTokens: 0,
    reliableRemainingTokens: null,
    tokenConfidence: 'unlimited',
  },
};

/** True when `next` is the same task as `cur` but not newer. Guards against out-of-order HTTP/SSE. */
function isStale(cur: Task | null | undefined, next: Task): boolean {
  return !!cur && cur.id === next.id && cur.updatedAt > next.updatedAt;
}

function mergeTask(list: Task[], next: Task): Task[] {
  const cur = list.find((t) => t.id === next.id);
  if (!cur) return [...list, next];
  if (isStale(cur, next)) return list;
  return list.map((t) => (t.id === next.id ? next : t));
}

const PLANNING_HINT = 'Claude is preparing a plan…';

interface SystemLine {
  at: string;
  text: string;
  error: boolean;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [projectUsage, setProjectUsage] = useState<UsageSummary>(EMPTY_USAGE);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [timeline, setTimeline] = useState<TaskEvent[]>([]);
  const [taskUsage, setTaskUsage] = useState<UsageSummary>(EMPTY_USAGE);
  const [budget, setBudget] = useState<ExecutionBudgetStatus>(EMPTY_BUDGET);
  const [runtime, setRuntime] = useState<RuntimeStatusResponse | null>(null);
  const [systemLog, setSystemLog] = useState<SystemLine[]>([]);
  const [draft, setDraft] = useState('');
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRoot, setNewRoot] = useState('');
  const [limits, setLimits] = useState<ExecutionLimitsInput>({
    maxClaudeRuns: 6,
    maxCodexRuns: 3,
    claudeTokenCeiling: null,
    codexTokenCeiling: null,
    maxClarificationRounds: 3,
    maxReviewRounds: 2,
  });

  const log = useCallback((text: string, error = false) => {
    setSystemLog((l) => [...l.slice(-199), { at: new Date().toISOString(), text, error }]);
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, true);
      } finally {
        setBusy(false);
      }
    },
    [log],
  );

  // ----- loading -----
  const loadProjects = useCallback(() => api.listProjects().then(setProjects), []);

  const loadProject = useCallback(async (id: string) => {
    const d = await api.projectDetail(id);
    setTasks(d.tasks);
    setMessages(d.messages);
    setProjectUsage(d.usage);
    const latest = d.tasks[d.tasks.length - 1];
    setTaskId((cur) => (cur && d.tasks.some((t) => t.id === cur) ? cur : (latest?.id ?? null)));
  }, []);

  /** Apply a task snapshot unless a newer version of the same task is already shown. */
  const applyTask = useCallback((next: Task) => {
    setTasks((ts) => mergeTask(ts, next));
    setTask((cur) => (cur && cur.id !== next.id ? cur : isStale(cur, next) ? cur : next));
  }, []);

  const loadTask = useCallback(async (id: string) => {
    const d = await api.taskDetail(id);
    // A later SSE update may already be applied; never roll it back.
    setTask((cur) => (isStale(cur, d.task) ? cur : d.task));
    setRuns(d.runs);
    setTimeline(d.timeline);
    setTaskUsage(d.usage);
    setBudget(d.budget);
  }, []);

  useEffect(() => {
    void run('load projects', loadProjects);
  }, [run, loadProjects]);

  useEffect(() => {
    void run('load runtime status', async () => {
      const status = await api.runtimeStatus();
      setRuntime(status);
      setLimits(status.defaultExecutionLimits);
    });
  }, [run]);

  useEffect(() => {
    if (projectId) void run('load project', () => loadProject(projectId));
  }, [projectId, run, loadProject]);

  useEffect(() => {
    if (taskId) void run('load task', () => loadTask(taskId));
    else {
      setTask(null);
      setRuns([]);
      setTimeline([]);
      setTaskUsage(EMPTY_USAGE);
      setBudget(EMPTY_BUDGET);
    }
  }, [taskId, run, loadTask]);

  // ----- live events -----
  const onEvent = useCallback(
    (e: SseEvent) => {
      switch (e.type) {
        case 'task_updated':
          if (e.task.projectId === projectId) {
            setTasks((ts) => mergeTask(ts, e.task));
            if (e.task.id === taskId) applyTask(e.task);
            if (!taskId) setTaskId(e.task.id);
          }
          return;
        case 'run_updated':
          if (e.run.taskId === taskId) {
            setRuns((rs) =>
              rs.some((r) => r.id === e.run.id)
                ? rs.map((r) => (r.id === e.run.id ? e.run : r))
                : [...rs, e.run],
            );
          }
          return;
        case 'message_added':
          if (e.message.projectId === projectId) setMessages((ms) => [...ms, e.message]);
          return;
        case 'timeline_appended':
          if (e.entry.taskId === taskId) setTimeline((tl) => [...tl, e.entry]);
          if (e.entry.type === 'state_changed')
            log(
              `task ${e.entry.taskId}: ${String(e.entry.payload['from'])} → ${String(e.entry.payload['to'])}`,
            );
          return;
        case 'usage_updated':
          if (e.projectId === projectId) setProjectUsage(e.project);
          if (e.taskId === taskId) setTaskUsage(e.task);
          return;
        case 'budget_updated':
          if (e.taskId === taskId) setBudget(e.budget);
          return;
        case 'system_error':
          log(`${e.code}: ${e.message}`, true);
          return;
      }
    },
    [projectId, taskId, log, applyTask],
  );
  const reloadAfterReconnect = useCallback(() => {
    if (projectId) void loadProject(projectId);
    if (taskId) void loadTask(taskId);
  }, [projectId, taskId, loadProject, loadTask]);
  useEvents(onEvent, reloadAfterReconnect);

  // ----- actions -----
  const submit = () => {
    if (!projectId || !draft.trim()) return;
    const text = draft;
    setDraft('');
    void run('submit', async () => {
      const t = await api.submitRequestWithLimits(projectId, text, limits);
      setTaskId(t.id);
      applyTask(t);
    });
  };

  const canAct = task && !busy;

  return (
    <div className="layout">
      <aside className="pane left">
        <h2>Projects</h2>
        {projects.map((p) => (
          <button
            key={p.id}
            className={`project${p.id === projectId ? ' active' : ''}`}
            onClick={() => setProjectId(p.id)}
            title={p.rootPath}
          >
            {p.name}
          </button>
        ))}
        <h2 style={{ marginTop: 16 }}>Register</h2>
        <input placeholder="name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input
          placeholder="absolute root path"
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          style={{ marginTop: 4 }}
        />
        <button
          style={{ marginTop: 4 }}
          disabled={busy || !newName.trim() || !newRoot.trim()}
          onClick={() =>
            void run('register project', async () => {
              const p = await api.registerProject({
                name: newName.trim(),
                rootPath: newRoot.trim(),
              });
              setNewName('');
              setNewRoot('');
              await loadProjects();
              setProjectId(p.id);
            })
          }
        >
          Add project
        </button>

        {tasks.length > 0 && (
          <div className="task-list" style={{ marginTop: 16 }}>
            <h2>Tasks</h2>
            {tasks.map((t) => (
              <button
                key={t.id}
                className={t.id === taskId ? 'active' : ''}
                onClick={() => setTaskId(t.id)}
              >
                <span className={`state ${t.state}`} style={{ fontSize: 10 }}>
                  {t.state}
                </span>{' '}
                {t.plan?.title ?? t.request.slice(0, 40)}
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="pane center">
        <h2>Chat</h2>
        <div className="messages">
          {!projectId && <p>Select or register a project to start.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="role">{m.role}</div>
              {m.content}
            </div>
          ))}
        </div>
        <div className="compose">
          <textarea
            placeholder={
              projectId
                ? 'Describe what you want built… (tip: add [fake-changes:1] to force one revision round)'
                : 'Select a project first'
            }
            value={draft}
            disabled={!projectId || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
            }}
          />
          <button disabled={!projectId || busy || !draft.trim()} onClick={submit}>
            Send
          </button>
        </div>
        <details className="limits" open>
          <summary>Execution limits</summary>
          <div className="limit-grid">
            <NumberLimit
              label="Claude runs"
              value={limits.maxClaudeRuns}
              onChange={(value) => setLimits((l) => ({ ...l, maxClaudeRuns: value }))}
            />
            <NumberLimit
              label="Codex runs"
              value={limits.maxCodexRuns}
              onChange={(value) => setLimits((l) => ({ ...l, maxCodexRuns: value }))}
            />
            <NumberLimit
              label="Clarification rounds"
              value={limits.maxClarificationRounds}
              onChange={(value) => setLimits((l) => ({ ...l, maxClarificationRounds: value }))}
            />
            <NumberLimit
              label="Review rounds"
              value={limits.maxReviewRounds}
              onChange={(value) => setLimits((l) => ({ ...l, maxReviewRounds: value }))}
            />
            <TokenLimit
              label="Claude token ceiling"
              value={limits.claudeTokenCeiling}
              onChange={(value) => setLimits((l) => ({ ...l, claudeTokenCeiling: value }))}
            />
            <TokenLimit
              label="Codex token ceiling"
              value={limits.codexTokenCeiling}
              onChange={(value) => setLimits((l) => ({ ...l, codexTokenCeiling: value }))}
            />
          </div>
          <p className="hint">
            Token ceilings are checked between runs; they are not provider hard caps and one run can
            cross the ceiling.
          </p>
        </details>
      </main>

      <aside className="pane right">
        <h2>Current task</h2>
        {!task && <p>No task selected.</p>}
        {task && (
          <>
            <p>
              <span className={`state ${task.state}`}>{task.state}</span>
            </p>
            <p>
              <strong>{task.plan?.title ?? task.request}</strong>
            </p>
            {task.state === 'draft' && <p className="hint">{PLANNING_HINT}</p>}
            {task.state === 'awaiting_clarification' && (
              <div className="clarification-box">
                <p>
                  Claude needs more information ({task.clarificationRound} /{' '}
                  {task.maxClarificationRounds}).
                </p>
                <textarea
                  aria-label="Clarification answer"
                  value={clarificationAnswer}
                  onChange={(e) => setClarificationAnswer(e.target.value)}
                  placeholder="Answer Claude's question"
                />
                <p>
                  <button
                    disabled={!canAct || !clarificationAnswer.trim()}
                    onClick={() => {
                      const answer = clarificationAnswer;
                      setClarificationAnswer('');
                      void run('clarification', () => api.clarify(task.id, answer));
                    }}
                  >
                    Send answer
                  </button>{' '}
                  <button
                    disabled={!canAct}
                    onClick={() => void run('reject', () => api.reject(task.id))}
                  >
                    Reject
                  </button>
                </p>
              </div>
            )}
            {task.plan && (
              <ol style={{ paddingLeft: 18 }}>
                {task.plan.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            {task.state === 'awaiting_approval' && (
              <div className="approval-box">
                <p>
                  Approval permits at most {budget.codex.remainingRuns} further Codex run(s) and{' '}
                  {budget.claude.remainingRuns} further Claude run(s), within this task's saved
                  limits.
                </p>
                <p>
                  <button
                    disabled={!canAct}
                    onClick={() => void run('approve', () => api.approve(task.id))}
                  >
                    Approve
                  </button>{' '}
                  <button
                    disabled={!canAct}
                    onClick={() => void run('reject', () => api.reject(task.id))}
                  >
                    Reject
                  </button>
                </p>
              </div>
            )}
            {!['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(task.state) && (
              <p>
                <button
                  disabled={!canAct}
                  onClick={() => void run('cancel', () => api.cancel(task.id))}
                >
                  Cancel
                </button>
              </p>
            )}
            <p>
              Clarification round {task.clarificationRound} / {task.maxClarificationRounds}
              <br />
              Review round {task.reviewRound} / {task.maxReviewRounds}
            </p>
            <div className="budget-card">
              <strong>Run and token limits</strong>
              <div>
                Claude: {budget.claude.usedRuns}/{budget.claude.maxRuns} runs ·{' '}
                {tokenRangeLabel(budget.claude)}
              </div>
              <div>
                Codex: {budget.codex.usedRuns}/{budget.codex.maxRuns} runs ·{' '}
                {tokenRangeLabel(budget.codex)}
              </div>
            </div>
            {task.failure && (
              <div className="error">
                <p>
                  {task.failure.code}: {task.failure.message}
                </p>
                <p>Next action: {nextAction(task)}</p>
              </div>
            )}
            <h2>Runs</h2>
            <ul style={{ paddingLeft: 18, fontSize: 12 }}>
              {runs.map((r) => (
                <li key={r.id}>
                  {r.provider} · {r.kind} · {r.status}
                  {r.hasSession && <span className="tag">session saved</span>}
                </li>
              ))}
            </ul>
            <UsageTable title="Task usage" usage={taskUsage} />
          </>
        )}
        <div style={{ marginTop: 12 }}>
          <UsageTable title="Project usage" usage={projectUsage} />
        </div>
        {task && (
          <>
            <h2 style={{ marginTop: 12 }}>Timeline</h2>
            <div className="timeline">
              {timeline.map((e) => (
                <div key={e.id}>
                  {e.createdAt.slice(11, 19)} {e.type} {summarizePayload(e)}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      <footer className="pane bottom">
        <h2>System</h2>
        {runtime && (
          <div className="runtime-status">
            Claude {runtime.claude.adapter}/{runtime.claude.executable}, {runtime.claude.timeoutMs}
            ms · Codex {runtime.codex.adapter}/{runtime.codex.executable}, {runtime.codex.timeoutMs}
            ms · review diff {runtime.reviewDiffMaxBytes} bytes · DB {runtime.database}
          </div>
        )}
        {systemLog.map((l, i) => (
          <div key={i} className={l.error ? 'error' : ''}>
            {l.at.slice(11, 19)} {l.text}
          </div>
        ))}
      </footer>
    </div>
  );
}

function NumberLimit({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))}
      />
    </label>
  );
}

function TokenLimit({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={1}
        placeholder="unlimited"
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? null : Math.max(1, Number(e.target.value)))
        }
      />
    </label>
  );
}

function summarizePayload(e: TaskEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'state_changed':
      return `${String(p['from'])} → ${String(p['to'])}`;
    case 'run_started':
    case 'run_finished':
      return `${String(p['provider'])}/${String(p['kind'])}${p['status'] ? ` ${String(p['status'])}` : ''}`;
    case 'command_started':
      return Array.isArray(p['command']) ? (p['command'] as string[]).join(' ') : '';
    case 'command_completed':
      return `exit ${String(p['exitCode'])}`;
    case 'usage_reported':
      return `${String(p['source'])} total=${String(p['totalTokens'])}`;
    case 'agent_message':
      return String(p['text']).slice(0, 80);
    default:
      return '';
  }
}
