import type { ExecutionLimitsInput } from '../../shared/contracts.js';
export function LimitSettings({
  value,
  onChange,
}: {
  value: ExecutionLimitsInput;
  onChange: (value: ExecutionLimitsInput) => void;
}) {
  return (
    <div className="limit-grid">
      {(
        [
          ['maxClaudeRuns', 'Claude 최대 실행 횟수', 100],
          ['maxCodexRuns', 'Codex 최대 실행 횟수', 100],
          ['maxClarificationRounds', '추가 질문 횟수', 20],
          ['maxReviewRounds', '결과 검토 횟수', 20],
          ['claudeTokenCeiling', 'Claude 토큰 상한', Number.MAX_SAFE_INTEGER],
          ['codexTokenCeiling', 'Codex 토큰 상한', Number.MAX_SAFE_INTEGER],
        ] as const
      ).map(([key, label, max]) => (
        <label key={key}>
          {label}
          <input
            type="number"
            min={1}
            max={max}
            value={value[key] ?? ''}
            placeholder={key.includes('Ceiling') ? '제한 없음' : undefined}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!e.target.value && key.includes('Ceiling')) onChange({ ...value, [key]: null });
              else if (Number.isSafeInteger(n) && n > 0 && n <= max)
                onChange({ ...value, [key]: n });
            }}
          />
        </label>
      ))}
    </div>
  );
}
