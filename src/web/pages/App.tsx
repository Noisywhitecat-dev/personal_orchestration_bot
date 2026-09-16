import { useEffect, useRef, useState } from 'react';
import type { ExecutionLimitsInput } from '../../shared/contracts.js';
import { presetLimits } from '../../shared/presets.js';
import { desktopBridge } from '../desktop-bridge.js';
import { taskPresentation, safeMessage } from '../view-model.js';
import { useWorkspace } from '../hooks/useWorkspace.js';
import { ProjectSidebar } from '../components/ProjectSidebar.js';
import { PlanCard } from '../components/PlanCard.js';
import { ExecutionSummary } from '../components/ExecutionSummary.js';
import { TaskDetails } from '../components/TaskDetails.js';
import { ProjectTools } from '../components/ProjectTools.js';
import { DesktopSettingsPanel } from '../components/DesktopSettingsPanel.js';
import { Onboarding } from '../components/Onboarding.js';
import { LimitSettings } from '../components/LimitSettings.js';

export function App() {
  const workspace = useWorkspace();
  const { projects, projectId, taskId, project, detail, runtime, busy, error } = workspace;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = `${projectId ?? ''}:${taskId ?? 'new'}`;
  const draft = drafts[draftKey] ?? '';
  const setDraft = (text: string) => setDrafts((current) => ({ ...current, [draftKey]: text }));
  const sending = useRef(false);
  const [limits, setLimits] = useState<ExecutionLimitsInput>(presetLimits('auto'));
  const [settings, setSettings] = useState(false);
  const [settingsOpened, setSettingsOpened] = useState(false);
  const openSettings = () => {
    setSettingsOpened(true);
    setSettings(true);
  };
  const [guide, setGuide] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [tools, setTools] = useState(false);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const previousTask = useRef<string | null>(null);
  const conversationScroll = useRef<HTMLDivElement>(null);
  const task = detail?.task ?? null;
  const presentation = taskPresentation(task);
  const fake = runtime?.claude.adapter === 'fake' && runtime.codex.adapter === 'fake';
  const messages = project?.messages.filter((m) => m.taskId === taskId) ?? [];
  useEffect(() => {
    if (runtime) setLimits(runtime.defaultExecutionLimits);
  }, [runtime]);
  useEffect(() => {
    if (desktopBridge) {
      void desktopBridge
        .getSettings()
        .then((s) => setGuide(!s.onboardingCompleted))
        .catch(() => setGuide(true));
    } else setGuide(localStorage.getItem('orchestrator-guide-v1') !== 'done');
  }, []);
  useEffect(() => {
    if (settings) settingsDialog.current?.showModal();
    else settingsDialog.current?.close();
  }, [settings]);
  useEffect(() => {
    if (nearBottom.current || previousTask.current !== taskId) {
      const scroller = conversationScroll.current;
      scroller?.scrollTo({ top: scroller.scrollHeight });
      nearBottom.current = true;
      setShowLatest(false);
    } else setShowLatest(true);
    previousTask.current = taskId;
  }, [messages.length, task?.state, taskId]);
  const newTask = () => {
    workspace.newTask();
    setSidebar(false);
    setTimeout(() => composer.current?.focus({ preventScroll: true }), 0);
  };
  const primaryAction = async () => {
    if (
      busy ||
      sending.current ||
      !projectId ||
      (taskId && !detail) ||
      presentation.action === 'wait'
    )
      return;
    sending.current = true;
    try {
      if (presentation.action === 'new') {
        newTask();
        return;
      }
      if (presentation.action === 'approve') {
        await workspace.taskAction('approve');
        return;
      }
      if (!draft.trim()) return;
      const ok =
        presentation.action === 'answer'
          ? await workspace.taskAction('clarify', draft.trim())
          : await workspace.submit(draft.trim(), limits);
      if (ok) setDraft('');
    } finally {
      sending.current = false;
    }
  };
  const waiting = presentation.action === 'wait';
  const composing = presentation.action === 'submit' || presentation.action === 'answer';
  const loadingTask = Boolean(taskId && !detail);
  return (
    <div className={`workspace ${sidebar ? 'sidebar-open' : ''}`}>
      <ProjectSidebar
        projects={projects}
        tasks={project?.tasks ?? []}
        projectId={projectId}
        taskId={taskId}
        busy={busy}
        runtime={runtime}
        onDelete={async (id) => {
          const ok = await workspace.deleteTask(id);
          if (ok)
            setDrafts((current) =>
              Object.fromEntries(
                Object.entries(current).filter(([key]) => !key.endsWith(':' + id)),
              ),
            );
          return ok;
        }}
        onProject={(id) => {
          workspace.selectProject(id);
          setSidebar(false);
        }}
        onTask={(id) => {
          workspace.selectTask(id);
          setSidebar(false);
        }}
        onNew={newTask}
        onRegister={workspace.register}
        onSettings={openSettings}
        onGuide={() => setGuide(true)}
      />
      <main className="conversation" aria-label="작업 대화">
        <header className="conversation-header">
          <button
            className="mobile-menu secondary"
            aria-expanded={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            프로젝트
          </button>
          <div>
            <h1>{project?.project.name ?? 'AI orchestrator'}</h1>
            <span className="muted">Claude · 계획/검토 · Codex · 구현</span>
          </div>
          <span className={`mode-badge ${fake ? 'fake' : ''}`}>
            {!runtime ? '연결 중' : fake ? '체험 모드' : '실제 AI 포함'}
          </span>
          <button
            className="secondary"
            disabled={!projectId}
            aria-expanded={tools}
            onClick={() => setTools(!tools)}
          >
            프로젝트 준비
          </button>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button className="text-button" onClick={() => workspace.setError('')}>
              닫기
            </button>
          </div>
        )}
        <div
          ref={conversationScroll}
          className="conversation-scroll"
          onScroll={(event) => {
            const el = event.currentTarget;
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (nearBottom.current) setShowLatest(false);
          }}
        >
          {guide && (
            <Onboarding
              onSettings={openSettings}
              onClose={async () => {
                if (desktopBridge) {
                  try {
                    await desktopBridge.completeOnboarding();
                  } catch {
                    workspace.setError(
                      '시작 안내 상태를 저장하지 못했습니다. 다음 실행 때 다시 표시될 수 있습니다.',
                    );
                  }
                } else localStorage.setItem('orchestrator-guide-v1', 'done');
                setGuide(false);
              }}
            />
          )}
          {tools && projectId && <ProjectTools key={projectId} projectId={projectId} />}
          {!taskId && (
            <section className="welcome">
              <h2>{projectId ? '새 작업' : '프로젝트 등록'}</h2>
              <p>
                {projectId
                  ? '요청을 입력하면 계획을 작성합니다. 승인 후 구현과 검토를 진행합니다.'
                  : '왼쪽에서 작업할 프로젝트 폴더를 등록하세요.'}
              </p>
              {fake && projectId && (
                <button
                  className="secondary"
                  onClick={() => {
                    setDraft('간단한 환영 페이지를 만들고 동작을 검증해주세요.');
                    composer.current?.focus();
                  }}
                >
                  체험 요청 채우기
                </button>
              )}
            </section>
          )}
          <div className="messages" aria-label="대화 기록">
            {messages.map((m) => (
              <article key={m.id} className={`message ${m.role}`}>
                <div className="message-author">
                  {m.role === 'user'
                    ? '나'
                    : m.role === 'claude'
                      ? 'Claude · 기획 및 검토'
                      : m.role === 'codex'
                        ? 'Codex · 코드 작성'
                        : '시스템'}
                </div>
                <div className="message-body">{safeMessage(m.role, m.content)}</div>
              </article>
            ))}
          </div>
          {loadingTask && <p role="status">작업 기록을 불러오는 중…</p>}
          {task?.plan &&
            (task.state === 'awaiting_approval' ? (
              <PlanCard plan={task.plan} />
            ) : (
              <details className="approved-plan">
                <summary>작업 계획 보기</summary>
                <PlanCard plan={task.plan} />
              </details>
            ))}
          {task?.state === 'awaiting_approval' && detail && (
            <ExecutionSummary limits={task} budget={detail.budget} />
          )}
          {task && (
            <div className={`stage-card ${task.state === 'failed' ? 'error' : ''}`} role="status">
              <strong>{presentation.stage}</strong>
              <p>{presentation.next}</p>
              {task.state === 'completed' && (
                <p>
                  {fake
                    ? '체험이 끝났습니다. 실제 파일 수정이나 토큰 소비는 없었습니다.'
                    : '대화의 변경 파일과 검증 결과를 확인하세요.'}
                </p>
              )}
            </div>
          )}
        </div>
        <footer className="composer-area">
          {showLatest && (
            <button
              className="secondary"
              onClick={() => {
                const scroller = conversationScroll.current;
                scroller?.scrollTo({ top: scroller.scrollHeight });
                nearBottom.current = true;
                setShowLatest(false);
              }}
            >
              최신 내용으로 이동
            </button>
          )}
          {task?.state === 'awaiting_clarification' && (
            <p className="composer-label">Claude의 질문에 답해주세요</p>
          )}
          {composing && (
            <textarea
              ref={composer}
              aria-label={presentation.action === 'answer' ? '추가 질문 답변' : '작업 요청'}
              placeholder={
                projectId
                  ? '만들고 싶은 것, 해결할 문제, 꼭 지킬 조건을 적어주세요…'
                  : '먼저 프로젝트를 등록하거나 선택하세요'
              }
              rows={3}
              maxLength={20000}
              aria-describedby="request-length"
              value={draft}
              disabled={!projectId || busy || loadingTask}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void primaryAction();
                }
              }}
            />
          )}
          {composing && (
            <small id="request-length" className="muted">
              {draft.length.toLocaleString()} / 20,000자 · 작성 중인 내용은 앱을 닫기 전까지
              유지됩니다.
            </small>
          )}
          <div className="composer-actions">
            <span className="muted">
              {fake ? '체험 모드 · 실제 토큰 사용 없음' : '실제 모드 · 요청 시 AI 호출'}
              {composing ? ' · Ctrl+Enter로 보내기' : ''}
            </span>
            <div className="button-row">
              {task && !['completed', 'failed', 'cancelled'].includes(task.state) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void workspace.taskAction(
                      task.state === 'awaiting_approval' ? 'reject' : 'cancel',
                    )
                  }
                >
                  {task.state === 'awaiting_approval' ? '계획 거절' : '작업 중단'}
                </button>
              )}
              <button
                className="primary"
                disabled={
                  !projectId || busy || waiting || loadingTask || (composing && !draft.trim())
                }
                onClick={() => void primaryAction()}
              >
                {busy ? '처리 중…' : presentation.button}
              </button>
            </div>
          </div>
          {!taskId && (
            <details className="request-limits">
              <summary>실행 요약과 고급 한도</summary>
              <ExecutionSummary limits={limits} />
              <LimitSettings value={limits} onChange={setLimits} />
            </details>
          )}
        </footer>
      </main>
      <TaskDetails detail={detail} runtime={runtime} projectUsage={project?.usage} />
      <dialog
        ref={settingsDialog}
        className="settings-dialog"
        onCancel={() => setSettings(false)}
        onClose={() => setSettings(false)}
      >
        <button
          className="dialog-close secondary"
          aria-label="설정 닫기"
          onClick={() => setSettings(false)}
        >
          닫기
        </button>
        {settingsOpened && <DesktopSettingsPanel />}
      </dialog>
    </div>
  );
}
