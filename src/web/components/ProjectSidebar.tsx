import { useState } from 'react';
import type { Project, Task } from '../../shared/contracts.js';
import { desktopBridge } from '../desktop-bridge.js';
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
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [error, setError] = useState('');
  return (
    <aside className="sidebar" aria-label="프로젝트와 최근 작업">
      <div className="brand">
        <span className="brand-mark">◈</span>
        <strong>함께 만드는 작업실</strong>
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
              }
            });
          }}
        >
          <label>
            프로젝트 이름
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 나의 웹사이트"
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
            ▱ <span>{p.name}</span>
          </button>
        ))}
      </nav>
      {!projects.length && <p className="muted">프로젝트 폴더를 등록하면 시작할 수 있어요.</p>}
      <h2>최근 작업</h2>
      <nav className="recent-tasks" aria-label="최근 작업">
        {[...tasks].reverse().map((t) => (
          <button
            key={t.id}
            className={`nav-item ${t.id === taskId ? 'selected' : ''}`}
            onClick={() => onTask(t.id)}
          >
            <span>
              {t.plan?.title ?? t.request.slice(0, 50)}
              <small>{taskStateLabel(t.state)}</small>
            </span>
          </button>
        ))}
      </nav>
      {!tasks.length && <p className="muted">아직 작업이 없습니다.</p>}
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
