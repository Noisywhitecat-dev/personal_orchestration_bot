import { useEffect, useState } from 'react';
import { emptyAccountUsage, type QuotaKind, type QuotaWindow } from '../../shared/account-usage.js';
import { desktopBridge } from '../desktop-bridge.js';

export function AccountUsagePanel({ compact = false }: { compact?: boolean }) {
  const [usage, setUsage] = useState(emptyAccountUsage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const update = () => {
      setNow(Date.now());
      void desktopBridge
        ?.getAccountUsage(false)
        .then((value) => {
          if (active) setUsage(value);
        })
        .catch(() => {
          if (active) setError('사용량을 불러오지 못했습니다.');
        });
    };
    update();
    const timer = setInterval(update, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const act = async (query: () => Promise<typeof usage>) => {
    setBusy(true);
    setError('');
    try {
      setUsage(await query());
      setNow(Date.now());
    } catch {
      setError('사용량 데이터를 읽지 못했습니다. 파일 형식 또는 CLI 연결을 확인하세요.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`account-usage ${compact ? 'compact' : ''}`} aria-label="계정 사용량">
      <h3>계정 사용량</h3>
      {!compact && (
        <p className="hint">
          계정 전체 한도입니다. 이 앱의 작업별 토큰과 별개이며, 확인 시각 이후 사용량은 반영되지
          않을 수 있습니다.
        </p>
      )}
      <Quota label="Codex 주간" kind="seven_day" windows={usage.codex} now={now} />
      <Quota label="Claude 5시간" kind="five_hour" windows={usage.claude} now={now} />
      <Quota label="Claude 주간" kind="seven_day" windows={usage.claude} now={now} />
      {usage.codexStatus === 'unavailable' && (
        <p role="status">
          Codex 사용량을 확인하지 못했습니다. CLI 설치·ChatGPT 로그인 또는 계정의 한도 제공 여부를
          확인하세요.
        </p>
      )}
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy || !desktopBridge}
          onClick={() => void act(() => desktopBridge!.getAccountUsage(true))}
        >
          {busy ? '조회 중…' : 'Codex 사용량 조회'}
        </button>
        <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
          Claude 사용량 페이지
        </a>
      </div>
      <details className="usage-help">
        <summary>조회 방법과 데이터 출처</summary>
        <p className="hint">
          조회는 AI 작업을 실행하지 않습니다. Claude는 실행 중 보고된 한도만 자동 반영합니다. 미보고
          값은 공식 사용량 페이지에서 확인하세요.
        </p>
        <details>
          <summary>Claude 상태 표시줄 데이터 가져오기</summary>
          <p className="hint">
            공식 statusline의 rate_limits가 포함된 JSON을 선택하세요. 사용률과 초기화 시각만
            메모리에 보관합니다. 가져온 값은 실시간 조회 결과가 아닙니다.
          </p>
          <input
            aria-label="Claude 사용량 JSON"
            type="file"
            accept="application/json,.json"
            disabled={busy || !desktopBridge}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              if (file.size > 65536) {
                setError('64KB 이하의 JSON 파일을 선택하세요.');
                return;
              }
              void act(async () => desktopBridge!.importClaudeUsage(await file.text()));
            }}
          />
        </details>
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function Quota({
  label,
  kind,
  windows,
  now,
}: {
  label: string;
  kind: QuotaKind;
  windows: QuotaWindow[];
  now: number;
}) {
  const window = windows.find((w) => w.kind === kind);
  const expired = window?.resetsAt != null && window.resetsAt * 1000 <= now;
  const date = (ms: number) => new Date(ms).toLocaleString('ko-KR', { timeZoneName: 'short' });
  return (
    <div className="account-window">
      <strong>{label}</strong>
      {!window ? (
        <p>확인 불가 · 보고된 데이터 없음</p>
      ) : (
        <>
          <p>
            {expired
              ? '초기화 시각 경과 · 현재 사용량 확인 필요'
              : `${window.usedPercent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}% 사용 · ${(100 - window.usedPercent).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}% 남음`}
          </p>
          {!expired && (
            <progress aria-label={`${label} 사용률`} max={100} value={window.usedPercent} />
          )}
          <p>초기화: {window.resetsAt === null ? '확인 불가' : date(window.resetsAt * 1000)}</p>
          <p className="hint">
            {window.source === 'import'
              ? '파일에서 가져옴'
              : window.source === 'claude_event'
                ? 'Claude 실행 중 보고'
                : 'Codex 조회'}{' '}
            · {date(window.observedAt)}
          </p>
        </>
      )}
    </div>
  );
}
