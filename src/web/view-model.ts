import type { ProviderBudgetStatus, Task } from '../shared/contracts.js';

export function tokenRangeLabel(status: ProviderBudgetStatus): string {
  if (status.tokenCeiling === null) return 'unlimited';
  if (status.reliableRemainingTokens !== null) {
    return `${status.reliableRemainingTokens.toLocaleString()} tokens remain`;
  }
  return `${status.knownTokens.toLocaleString()} known / ${status.tokenCeiling.toLocaleString()} ceiling (${status.tokenConfidence})`;
}

export function nextAction(task: Task): string | null {
  if (!task.failure) return null;
  if (task.failure.code.includes('RUN_LIMIT') || task.failure.code.includes('TOKEN_CEILING')) {
    return 'Create a new task with a higher execution limit after reviewing recorded usage.';
  }
  if (task.failure.code === 'CLARIFICATION_ROUNDS_EXCEEDED') {
    return 'Create a new task with the missing details included or a higher clarification limit.';
  }
  if (task.failure.code === 'INTERRUPTED')
    return 'Review the task history, then submit a new task.';
  return 'Review the timeline and retry as a new task after fixing the reported cause.';
}
