import type { ProviderBudgetStatus, Task } from '../shared/contracts.js';

export function tokenRangeLabel(status: ProviderBudgetStatus): string {
  if (status.tokenCeiling === null) return '무제한';
  if (status.reliableRemainingTokens !== null) {
    return `${status.reliableRemainingTokens.toLocaleString()}토큰 남음`;
  }
  const confidence = status.tokenConfidence === 'estimated' ? '추정' : '확인 불가';
  return `확인된 토큰 ${status.knownTokens.toLocaleString()} / 상한 ${status.tokenCeiling.toLocaleString()} (${confidence})`;
}

export function nextAction(task: Task): string | null {
  if (!task.failure) return null;
  if (task.failure.code.includes('RUN_LIMIT') || task.failure.code.includes('TOKEN_CEILING')) {
    return '기록된 사용량을 확인한 뒤 실행 한도를 높여 새 작업을 만드세요.';
  }
  if (task.failure.code === 'CLARIFICATION_ROUNDS_EXCEEDED') {
    return '누락된 내용을 요청에 포함하거나 추가 질문 한도를 높여 새 작업을 만드세요.';
  }
  if (task.failure.code === 'INTERRUPTED')
    return '작업 기록을 확인한 뒤 새 작업으로 다시 요청하세요.';
  return '진행 기록에서 원인을 확인하고 문제를 해결한 뒤 새 작업으로 다시 요청하세요.';
}
