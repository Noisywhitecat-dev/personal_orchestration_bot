import type { ExecutionLimitsInput, ExecutionBudgetStatus } from '../../shared/contracts.js';
export function ExecutionSummary({
  limits,
  budget,
}: {
  limits: ExecutionLimitsInput & { reviewRound?: number };
  budget?: ExecutionBudgetStatus;
}) {
  const reviews = Math.max(0, limits.maxReviewRounds - (limits.reviewRound ?? 0));
  const claudeCalls = Math.min(
    budget?.claude.remainingRuns ?? limits.maxClaudeRuns,
    budget ? reviews : 1 + limits.maxClarificationRounds + reviews,
  );
  const codexCalls = Math.min(budget?.codex.remainingRuns ?? limits.maxCodexRuns, reviews);
  const tokens = (n: number | null) => (n === null ? '설정하지 않음' : `${n.toLocaleString()}토큰`);
  return (
    <div className="execution-summary">
      <strong>실행 전 확인</strong>
      <p>
        {budget ? '승인 후 추가로' : '이 작업에서'} Claude 최대 {claudeCalls}회, Codex 최대{' '}
        {codexCalls}회 실행할 수 있습니다. 결과 검토는 최대 {limits.maxReviewRounds}회입니다.
      </p>
      <p>
        토큰 상한 — Claude: {tokens(limits.claudeTokenCeiling)} · Codex:{' '}
        {tokens(limits.codexTokenCeiling)}
      </p>
      <small>
        토큰 상한은 실행이 끝난 뒤 다음 호출을 제한합니다. 한 번의 실행은 상한을 넘을 수 있습니다.
        실제 모드에서는 실행과 후속 검토에 토큰이 사용됩니다.
      </small>
    </div>
  );
}
