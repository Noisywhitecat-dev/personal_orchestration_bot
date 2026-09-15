import { useCallback, useEffect, useState } from 'react';

import type {
  Message,
  Project,
  Run,
  SseEvent,
  Task,
  TaskEvent,
  UsageSummary,
} from '../../shared/contracts.js';
import { api } from '../api.js';
import { UsageTable } from '../components/UsageTable.js';
import { useEvents } from '../hooks/useEvents.js';

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
  const [systemLog, setSystemLog] = useState<SystemLine[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRoot, setNewRoot] = useState('');

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

  const loadTask = useCallback(async (id: string) => {
    const d = await api.taskDetail(id);
    setTask(d.task);
    setRuns(d.runs);
    setTimeline(d.timeline);
    setTaskUsage(d.usage);
  }, []);

  useEffect(() => {
    void run('load projects', loadProjects);
  }, [run, loadProjects]);

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
    }
  }, [taskId, run, loadTask]);

  // ----- live events -----
  const onEvent = useCallback(
    (e: SseEvent) => {
      switch (e.type) {
        case 'task_updated':
          if (e.task.projectId === projectId) {
            setTasks((ts) =>
              ts.some((t) => t.id === e.task.id)
                ? ts.map((t) => (t.id === e.task.id ? e.task : t))
                : [...ts, e.task],
            );
            if (e.task.id === taskId) setTask(e.task);
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
        case 'system_error':
          log(`${e.code}: ${e.message}`, true);
          return;
      }
    },
    [projectId, taskId, log],
  );
  useEvents(onEvent);

  // ----- actions -----
  const submit = () => {
    if (!projectId || !draft.trim()) return;
    const text = draft;
    setDraft('');
    void run('submit', async () => {
      const t = await api.submitRequest(projectId, text);
      setTaskId(t.id);
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
            {task.plan && (
              <ol style={{ paddingLeft: 18 }}>
                {task.plan.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            {task.state === 'awaiting_approval' && (
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
              Review round {task.reviewRound} / {task.maxReviewRounds}
            </p>
            {task.failure && (
              <p className="error">
                {task.failure.code}: {task.failure.message}
              </p>
            )}
            <h2>Runs</h2>
            <ul style={{ paddingLeft: 18, fontSize: 12 }}>
              {runs.map((r) => (
                <li key={r.id}>
                  {r.provider} · {r.kind} · {r.status}
                  {r.sessionId && <span className="tag">{r.sessionId.slice(0, 18)}</span>}
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
        {systemLog.map((l, i) => (
          <div key={i} className={l.error ? 'error' : ''}>
            {l.at.slice(11, 19)} {l.text}
          </div>
        ))}
      </footer>
    </div>
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
