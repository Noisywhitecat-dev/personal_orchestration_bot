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
import { DesktopSettingsPanel } from '../components/DesktopSettingsPanel.js';
import { UsageTable } from '../components/UsageTable.js';
import { desktopBridge } from '../desktop-bridge.js';
import { useEvents } from '../hooks/useEvents.js';
import {
  messageRoleLabel,
  providerLabel,
  runKindLabel,
  runStatusLabel,
  taskStateLabel,
  timelineTypeLabel,
  valueLabel,
} from '../i18n.js';
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

const PLANNING_HINT = 'Claude가 작업 계획을 작성하고 있습니다…';

interface SystemLine {
  at: string;
  text: string;
  error: boolean;
}

export function App() {
  const bridge = desktopBridge;
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
        log(`${label} 실패: ${err instanceof Error ? err.message : String(err)}`, true);
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
    void run('프로젝트 불러오기', loadProjects);
  }, [run, loadProjects]);

  useEffect(() => {
    void run('실행 환경 불러오기', async () => {
      const status = await api.runtimeStatus();
      setRuntime(status);
      setLimits(status.defaultExecutionLimits);
    });
  }, [run]);

  useEffect(() => {
    if (projectId) void run('프로젝트 불러오기', () => loadProject(projectId));
  }, [projectId, run, loadProject]);

  useEffect(() => {
    if (taskId) void run('작업 불러오기', () => loadTask(taskId));
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
              `작업 ${e.entry.taskId}: ${valueLabel(e.entry.payload['from'])} → ${valueLabel(e.entry.payload['to'])}`,
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
    void run('요청 보내기', async () => {
      const t = await api.submitRequestWithLimits(projectId, text, limits);
      setTaskId(t.id);
      applyTask(t);
    });
  };

  const canAct = task && !busy;

  return (
    <div className="layout">
      <aside className="pane left">
        <h2>프로젝트</h2>
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
        <h2 style={{ marginTop: 16 }}>프로젝트 등록</h2>
        <input
          placeholder="프로젝트 이름"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          placeholder="프로젝트 폴더의 전체 경로"
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          style={{ marginTop: 4 }}
        />
        {bridge && (
          <button
            type="button"
            className="secondary"
            style={{ marginTop: 4 }}
            onClick={() =>
              void bridge.chooseProjectDirectory().then((path) => {
                if (path) setNewRoot(path);
              })
            }
          >
            폴더 선택
          </button>
        )}
        <button
          style={{ marginTop: 4 }}
          disabled={busy || !newName.trim() || !newRoot.trim()}
          onClick={() =>
            void run('프로젝트 등록', async () => {
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
          프로젝트 추가
        </button>

        {tasks.length > 0 && (
          <div className="task-list" style={{ marginTop: 16 }}>
            <h2>작업 목록</h2>
            {tasks.map((t) => (
              <button
                key={t.id}
                className={t.id === taskId ? 'active' : ''}
                onClick={() => setTaskId(t.id)}
              >
                <span className={`state ${t.state}`} style={{ fontSize: 10 }}>
                  {taskStateLabel(t.state)}
                </span>{' '}
                {t.plan?.title ?? t.request.slice(0, 40)}
              </button>
            ))}
          </div>
        )}
        <DesktopSettingsPanel />
      </aside>

      <main className="pane center">
        <h2>대화</h2>
        <div className="messages">
          {!projectId && <p>시작하려면 프로젝트를 선택하거나 새로 등록하세요.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="role">{messageRoleLabel(m.role)}</div>
              {m.content}
            </div>
          ))}
        </div>
        <div className="compose">
          <textarea
            placeholder={
              projectId
                ? '만들거나 수정할 내용을 입력하세요… (체험 모드에서 수정 과정을 보려면 [fake-changes:1]을 덧붙이세요)'
                : '먼저 프로젝트를 선택하세요'
            }
            value={draft}
            disabled={!projectId || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
            }}
          />
          <button disabled={!projectId || busy || !draft.trim()} onClick={submit}>
            보내기
          </button>
        </div>
        <details className="limits" open>
          <summary>실행 한도</summary>
          <div className="limit-grid">
            <NumberLimit
              label="Claude 실행 횟수"
              value={limits.maxClaudeRuns}
              onChange={(value) => setLimits((l) => ({ ...l, maxClaudeRuns: value }))}
            />
            <NumberLimit
              label="Codex 실행 횟수"
              value={limits.maxCodexRuns}
              onChange={(value) => setLimits((l) => ({ ...l, maxCodexRuns: value }))}
            />
            <NumberLimit
              label="추가 질문 횟수"
              value={limits.maxClarificationRounds}
              onChange={(value) => setLimits((l) => ({ ...l, maxClarificationRounds: value }))}
            />
            <NumberLimit
              label="리뷰 횟수"
              value={limits.maxReviewRounds}
              onChange={(value) => setLimits((l) => ({ ...l, maxReviewRounds: value }))}
            />
            <TokenLimit
              label="Claude 토큰 상한"
              value={limits.claudeTokenCeiling}
              onChange={(value) => setLimits((l) => ({ ...l, claudeTokenCeiling: value }))}
            />
            <TokenLimit
              label="Codex 토큰 상한"
              value={limits.codexTokenCeiling}
              onChange={(value) => setLimits((l) => ({ ...l, codexTokenCeiling: value }))}
            />
          </div>
          <p className="hint">
            토큰 상한은 각 실행이 끝난 뒤 확인합니다. AI 서비스 자체의 강제 한도가 아니므로 한 번의
            실행에서 상한을 넘을 수 있습니다.
          </p>
        </details>
      </main>

      <aside className="pane right">
        <h2>현재 작업</h2>
        {!task && <p>선택된 작업이 없습니다.</p>}
        {task && (
          <>
            <p>
              <span className={`state ${task.state}`}>{taskStateLabel(task.state)}</span>
            </p>
            <p>
              <strong>{task.plan?.title ?? task.request}</strong>
            </p>
            {task.state === 'draft' && <p className="hint">{PLANNING_HINT}</p>}
            {task.state === 'awaiting_clarification' && (
              <div className="clarification-box">
                <p>
                  Claude가 추가 정보를 요청했습니다 ({task.clarificationRound} /{' '}
                  {task.maxClarificationRounds}).
                </p>
                <textarea
                  aria-label="추가 질문 답변"
                  value={clarificationAnswer}
                  onChange={(e) => setClarificationAnswer(e.target.value)}
                  placeholder="Claude의 질문에 답변하세요"
                />
                <p>
                  <button
                    disabled={!canAct || !clarificationAnswer.trim()}
                    onClick={() => {
                      const answer = clarificationAnswer;
                      setClarificationAnswer('');
                      void run('답변 보내기', () => api.clarify(task.id, answer));
                    }}
                  >
                    답변 보내기
                  </button>{' '}
                  <button
                    disabled={!canAct}
                    onClick={() => void run('작업 거절', () => api.reject(task.id))}
                  >
                    거절
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
                  승인하면 저장된 한도 안에서 Codex를 최대 {budget.codex.remainingRuns}회, Claude를
                  최대 {budget.claude.remainingRuns}회 더 실행할 수 있습니다.
                </p>
                <p>
                  <button
                    disabled={!canAct}
                    onClick={() => void run('계획 승인', () => api.approve(task.id))}
                  >
                    승인
                  </button>{' '}
                  <button
                    disabled={!canAct}
                    onClick={() => void run('작업 거절', () => api.reject(task.id))}
                  >
                    거절
                  </button>
                </p>
              </div>
            )}
            {!['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(task.state) && (
              <p>
                <button
                  disabled={!canAct}
                  onClick={() => void run('작업 취소', () => api.cancel(task.id))}
                >
                  취소
                </button>
              </p>
            )}
            <p>
              추가 질문 {task.clarificationRound} / {task.maxClarificationRounds}회
              <br />
              리뷰 {task.reviewRound} / {task.maxReviewRounds}회
            </p>
            <div className="budget-card">
              <strong>실행 및 토큰 한도</strong>
              <div>
                Claude: {budget.claude.usedRuns}/{budget.claude.maxRuns}회 ·{' '}
                {tokenRangeLabel(budget.claude)}
              </div>
              <div>
                Codex: {budget.codex.usedRuns}/{budget.codex.maxRuns}회 ·{' '}
                {tokenRangeLabel(budget.codex)}
              </div>
            </div>
            {task.failure && (
              <div className="error">
                <p>
                  {task.failure.code}: {task.failure.message}
                </p>
                <p>다음 조치: {nextAction(task)}</p>
              </div>
            )}
            <h2>AI 실행 기록</h2>
            <ul style={{ paddingLeft: 18, fontSize: 12 }}>
              {runs.map((r) => (
                <li key={r.id}>
                  {providerLabel(r.provider)} · {runKindLabel(r.kind)} · {runStatusLabel(r.status)}
                  {r.hasSession && <span className="tag">세션 저장됨</span>}
                </li>
              ))}
            </ul>
            <UsageTable title="작업 토큰 사용량" usage={taskUsage} />
          </>
        )}
        <div style={{ marginTop: 12 }}>
          <UsageTable title="프로젝트 토큰 사용량" usage={projectUsage} />
        </div>
        {task && (
          <>
            <h2 style={{ marginTop: 12 }}>진행 기록</h2>
            <div className="timeline">
              {timeline.map((e) => (
                <div key={e.id}>
                  {e.createdAt.slice(11, 19)} {timelineTypeLabel(e.type)} {summarizePayload(e)}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      <footer className="pane bottom">
        <h2>시스템</h2>
        {runtime && (
          <div className="runtime-status">
            Claude {valueLabel(runtime.claude.adapter)}/{valueLabel(runtime.claude.executable)},{' '}
            {runtime.claude.timeoutMs}밀리초 · Codex {valueLabel(runtime.codex.adapter)}/
            {valueLabel(runtime.codex.executable)}, {runtime.codex.timeoutMs}밀리초 · 리뷰 변경 내용{' '}
            {runtime.reviewDiffMaxBytes}바이트 · DB {runtime.database}
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
        placeholder="무제한"
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
      return `${valueLabel(p['from'])} → ${valueLabel(p['to'])}`;
    case 'run_started':
    case 'run_finished':
      return `${valueLabel(p['provider'])}/${valueLabel(p['kind'])}${p['status'] ? ` ${valueLabel(p['status'])}` : ''}`;
    case 'command_started':
      return Array.isArray(p['command']) ? (p['command'] as string[]).join(' ') : '';
    case 'command_completed':
      return `종료 코드 ${String(p['exitCode'])}`;
    case 'usage_reported':
      return `${valueLabel(p['source'])} 합계=${String(p['totalTokens'])}`;
    case 'agent_message':
      return String(p['text']).slice(0, 80);
    default:
      return '';
  }
}
