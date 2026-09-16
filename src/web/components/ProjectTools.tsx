import { useEffect, useState } from 'react';
import type { HarnessPreview, PreflightResult } from '../../shared/project-tools.js';
import { api } from '../api.js';
import { errorGuidance } from '../view-model.js';

export function ProjectTools({ projectId }: { projectId: string }) {
  const [preview, setPreview] = useState<HarnessPreview | null>(null);
  const [check, setCheck] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void api
      .harness(projectId)
      .then((p) => {
        if (active) setPreview(p);
      })
      .catch((e) => {
        if (active) setMessage(errorGuidance(e));
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  const inspect = async () => {
    setBusy(true);
    setMessage('');
    try {
      setCheck(await api.preflight(projectId));
    } catch (e) {
      setMessage(errorGuidance(e));
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    missing: '새로 생성',
    installed: '설치됨',
    conflict: '기존 파일 보존',
    blocked: '경로 차단',
    outdated: '수정됨 · 수동 병합',
  };
  return (
    <section className="project-tools">
      <h2>프로젝트 준비</h2>
      <p className="muted">AI를 호출하지 않고 실행 환경을 점검합니다.</p>
      <button className="secondary" disabled={busy} onClick={() => void inspect()}>
        {busy ? '확인 중…' : '실행 전 점검'}
      </button>
      {check && (
        <div className="check-list" role="status">
          {check.checks.map((c) => (
            <div key={c.key} className={`check ${c.status}`}>
              <strong>
                {c.status === 'ok' ? '✓' : '!'} {c.label}
              </strong>
              <p>{c.detail}</p>
            </div>
          ))}
        </div>
      )}
      <details className="harness">
        <summary>프로젝트 AI 하네스 · 설치 미리보기</summary>
        <p>
          Claude와 Codex가 이 프로젝트에서 사용할 협업 규칙입니다. 설치하지 않아도 작업할 수
          있습니다.
        </p>
        {preview && (
          <>
            <p>
              버전 {preview.version} · {preview.installed ? '역할 스킬 설치됨' : '설치 확인 필요'}
            </p>
            <ul>
              {preview.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className={`file-status ${f.state}`}>{labels[f.state]}</span>
                  <details>
                    <summary>생성 내용 보기</summary>
                    <pre>{f.content}</pre>
                  </details>
                </li>
              ))}
            </ul>
            <p className="hint">{preview.guidance}</p>
            <button
              disabled={busy || !preview.files.some((f) => f.state === 'missing')}
              onClick={() => {
                setBusy(true);
                void api
                  .installHarness(projectId)
                  .then((result) => {
                    setPreview(result);
                    setMessage(
                      `${result.created.length}개 파일을 생성했습니다. ${result.skipped.length}개 기존·차단 항목은 보존했습니다.`,
                    );
                    setCheck(null);
                  })
                  .catch((e) => setMessage(errorGuidance(e)))
                  .finally(() => setBusy(false));
              }}
            >
              확인한 파일을 프로젝트에 설치
            </button>
          </>
        )}
      </details>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
