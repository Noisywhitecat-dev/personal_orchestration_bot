import { useState } from 'react';
import type {
  RuntimeStatusResponse,
  TaskDetailResponse,
  UsageSummary,
} from '../../shared/contracts.js';
import { diagnosticSummary } from '../../shared/diagnostics.js';
import { taskPresentation } from '../view-model.js';
import { runKindLabel, runStatusLabel, timelineTypeLabel } from '../i18n.js';
import { UsageTable } from './UsageTable.js';

function total(usage: UsageSummary['claude']) {
  return `${usage.totalTokens === null ? '확인 불가' : `${usage.totalTokens.toLocaleString()}토큰`}${usage.hasEstimated ? ' · 추정 포함' : ''}${usage.hasUnavailable ? ' · 미보고 포함' : ''}`;
}
export function TaskDetails({
  detail,
  runtime,
  projectUsage,
}: {
  detail: TaskDetailResponse | null;
  runtime: RuntimeStatusResponse | null;
  projectUsage: UsageSummary | undefined;
}) {
  const presentation = taskPresentation(detail?.task ?? null);
  const [message, setMessage] = useState('');
  const fake = runtime?.claude.adapter === 'fake' && runtime.codex.adapter === 'fake';
  const exportText = () => JSON.stringify(diagnosticSummary(runtime, detail), null, 2);
  return (
    <aside className="task-info" aria-label="작업 정보">
      <div className="eyebrow">지금 진행 상황</div>
      <h2>{presentation.stage}</h2>
      <p>{presentation.next}</p>
      <h3>이번 작업의 토큰</h3>
      {fake && <p className="fake-label">체험용 예시 사용량 · 실제 소비 없음</p>}
      {detail ? (
        <div className="usage-summary">
          <p>
            <span className="claude-text">Claude</span>
            <strong>{total(detail.usage.claude)}</strong>
          </p>
          <p>
            <span className="codex-text">Codex</span>
            <strong>{total(detail.usage.codex)}</strong>
          </p>
        </div>
      ) : (
        <p className="muted">작업을 시작하면 여기에 표시됩니다.</p>
      )}
      <details className="advanced-details">
        <summary>상세 정보</summary>
        {detail && (
          <>
            <h3>단계별 실행과 사용량</h3>
            <ul>
              {detail.runs.map((r) => {
                const events = detail.timeline.filter(
                  (e) => e.runId === r.id && e.type === 'usage_reported',
                );
                const tokens = events.map((e) =>
                  typeof e.payload['totalTokens'] === 'number' ? e.payload['totalTokens'] : null,
                );
                const unavailable = !tokens.length || tokens.some((t) => t === null);
                const estimated = events.some((e) => e.payload['source'] === 'estimated');
                return (
                  <li key={r.id}>
                    {r.provider === 'claude' ? 'Claude' : 'Codex'} · {runKindLabel(r.kind)} ·{' '}
                    {runStatusLabel(r.status)}
                    <p>
                      {unavailable
                        ? '사용량 확인 불가'
                        : `${tokens.reduce<number>((sum, t) => sum + (t ?? 0), 0).toLocaleString()}토큰`}
                      {estimated ? ' (추정)' : ''} ·{' '}
                      {r.hasSession ? '이어서 작업 가능' : '세션 없음'}
                    </p>
                  </li>
                );
              })}
            </ul>
            <p>
              Claude {detail.budget.claude.usedRuns}/{detail.budget.claude.maxRuns}회 · Codex{' '}
              {detail.budget.codex.usedRuns}/{detail.budget.codex.maxRuns}회
            </p>
            <UsageTable title="작업 상세 사용량" usage={detail.usage} />
            <h3>내부 이벤트</h3>
            <ul className="event-list">
              {detail.timeline.map((e) => (
                <li key={e.id}>
                  {timelineTypeLabel(e.type)} · {new Date(e.createdAt).toLocaleTimeString('ko-KR')}
                </li>
              ))}
            </ul>
          </>
        )}
        {projectUsage && <UsageTable title="프로젝트 누적 사용량" usage={projectUsage} />}
        <h3>진단 정보 내보내기</h3>
        <p className="hint">
          경로, 이름, 요청·응답 원문, 세션 ID, diff, 명령 출력과 비밀값을 제외합니다.
        </p>
        <div className="button-row">
          <button
            className="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(exportText())
                .then(() => setMessage('진단 요약을 복사했습니다.'))
                .catch(() => setMessage('복사할 수 없습니다. 파일 저장을 이용하세요.'))
            }
          >
            요약 복사
          </button>
          <button
            className="secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([exportText()], { type: 'application/json' }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = 'orchestrator-diagnostics.json';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setMessage('진단 파일을 저장했습니다.');
            }}
          >
            파일 저장
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </details>
    </aside>
  );
}
