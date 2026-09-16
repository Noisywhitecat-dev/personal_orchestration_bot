import { useEffect, useState } from 'react';
import type { Project, Task } from '../../shared/contracts.js';
import { desktopBridge } from '../desktop-bridge.js';
import { DeleteTaskDialog } from './DeleteTaskDialog.js';
import { SidebarSettings } from './SidebarSettings.js';
import type { RuntimeStatusResponse } from '../../shared/contracts.js';
import { taskStateLabel } from '../i18n.js';

export function ProjectSidebar({
  projects,
  tasks,
  projectId,
  taskId,
  busy,
  onProject,
  onTask,
  onNew,
  onRegister,
  onSettings,
  onGuide,
  onDelete,
  runtime,
}: {
  projects: Project[];
  tasks: Task[];
  projectId: string | null;
  taskId: string | null;
  busy: boolean;
  onProject: (id: string) => void;
  onTask: (id: string) => void;
  onNew: () => void;
  onRegister: (name: string, root: string) => Promise<boolean>;
  onSettings: () => void;
  onGuide: () => void;
  onDelete: (id: string) => Promise<boolean>;
  runtime: RuntimeStatusResponse | null;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [projectId]);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const filtered = [...tasks]
    .reverse()
    .filter((t) =>
      `${t.plan?.title ?? ''} ${t.request}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [error, setError] = useState('');
  return (
    <aside className="sidebar" aria-label="프로젝트와 최근 작업">
      <div className="brand">
        <strong>AI orchestrator</strong>
      </div>
      <button className="primary new-task" onClick={onNew} disabled={!projectId}>
        ＋ 새 작업
      </button>
      <div className="section-heading">
        <h2>프로젝트</h2>
        <button className="text-button" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          ＋ 새 프로젝트
        </button>
      </div>
      {adding && (
        <form
          className="registration"
          onSubmit={(e) => {
            e.preventDefault();
            void onRegister(name.trim(), root.trim()).then((ok) => {
              if (ok) {
                setAdding(false);
                setName('');
                setRoot('');
                setError('');
              } else setError('등록하지 못했습니다. 폴더 경로를 확인하세요.');
            });
          }}
        >
          <label>
            프로젝트 이름
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 고객 관리"
            />
          </label>
          <label>
            프로젝트 폴더
            <input
              required
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="프로젝트 폴더의 전체 경로"
            />
          </label>
          {desktopBridge && (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void desktopBridge
                  ?.chooseProjectDirectory()
                  .then((path) => {
                    if (path) setRoot(path);
                  })
                  .catch(() => setError('폴더 선택을 열지 못했습니다. 경로를 직접 입력하세요.'))
              }
            >
              폴더 선택
            </button>
          )}
          <button type="submit" disabled={busy || !name.trim() || !root.trim()}>
            프로젝트 등록
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <nav aria-label="등록된 프로젝트">
        {projects.map((p) => (
          <button
            key={p.id}
            className={`nav-item ${p.id === projectId ? 'selected' : ''}`}
            aria-current={p.id === projectId ? 'page' : undefined}
            onClick={() => onProject(p.id)}
          >
            <span>
              {p.name}
              <small className="project-path">{p.rootPath}</small>
            </span>
          </button>
        ))}
      </nav>
      {!projects.length && <p className="muted">등록된 프로젝트가 없습니다.</p>}
      <h2>최근 작업</h2>
      {tasks.length > 0 && (
        <input
          aria-label="작업 검색"
          placeholder="작업 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <nav className="recent-tasks" aria-label="최근 작업">
        {filtered.map((t) => (
          <div className="task-row" key={t.id}>
            <button
              aria-current={t.id === taskId ? 'page' : undefined}
              className={`nav-item ${t.id === taskId ? 'selected' : ''}`}
              onClick={() => onTask(t.id)}
            >
              <span>
                {t.plan?.title ?? t.request.slice(0, 50)}
                <small>
                  {taskStateLabel(t.state)} · {new Date(t.createdAt).toLocaleDateString('ko-KR')}
                </small>
              </span>
            </button>
            <button
              className="text-button delete-task"
              aria-label={'대화 삭제: ' + (t.plan?.title ?? t.request.slice(0, 50))}
              disabled={busy || !['completed', 'failed', 'cancelled'].includes(t.state)}
              title={
                ['completed', 'failed', 'cancelled'].includes(t.state)
                  ? '대화 삭제'
                  : '작업을 중단한 뒤 삭제할 수 있습니다'
              }
              onClick={() => setDeleting(t)}
            >
              삭제
            </button>
          </div>
        ))}
      </nav>
      {tasks.length > 0 && !filtered.length && <p className="muted">검색 결과가 없습니다.</p>}
      {deleting && (
        <DeleteTaskDialog task={deleting} onDelete={onDelete} onClose={() => setDeleting(null)} />
      )}
      {!tasks.length && <p className="muted">아직 작업이 없습니다.</p>}
      <SidebarSettings runtime={runtime} onSettings={onSettings} />
      <div className="sidebar-footer">
        <button className="secondary" onClick={onSettings}>
          앱 설정
        </button>
        <button className="text-button" onClick={onGuide}>
          시작 안내
        </button>
      </div>
    </aside>
  );
}
