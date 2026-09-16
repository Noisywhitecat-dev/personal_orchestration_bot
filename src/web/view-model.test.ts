import { describe, expect, it } from 'vitest';

import type { ProviderBudgetStatus, Task } from '../shared/contracts.js';
import {
  nextAction,
  tokenRangeLabel,
  taskPresentation,
  errorGuidance,
  safeMessage,
} from './view-model.js';
import { TASK_STATES } from '../domain/task.js';

describe('web view model', () => {
  it('maps every state to a Korean stage and exactly one primary action', () => {
    expect(taskPresentation(null).action).toBe('submit');
    for (const state of TASK_STATES) {
      const view = taskPresentation({
        state,
        failure: { code: 'INTERRUPTED', message: 'raw' },
      } as Task);
      expect(view.stage).toMatch(/[가-힣]/);
      expect(view.button).toMatch(/[가-힣]/);
      expect(['submit', 'answer', 'approve', 'new', 'wait']).toContain(view.action);
      if (state === 'awaiting_approval') expect(view.action).toBe('approve');
      if (state === 'failed') expect(view.next).toContain('추가 AI 호출');
    }
  });
  it('gives actionable errors without exposing CLI text or internal state', () => {
    expect(errorGuidance(new Error('INVALID_PROJECT_ROOT: SECRET'))).toContain('폴더');
    expect(errorGuidance(new Error('fetch failed SECRET'))).toContain('새로 고침');
    expect(errorGuidance(new Error('SECRET'))).not.toContain('SECRET');
    expect(safeMessage('system', 'Task failed (SECRET): raw')).not.toContain('SECRET');
    expect(safeMessage('user', 'my original draft')).toBe('my original draft');
  });
  it('does not show uncertain token usage as a definite remainder', () => {
    const status = {
      tokenCeiling: 100,
      knownTokens: 20,
      reliableRemainingTokens: null,
      tokenConfidence: 'estimated',
    } as ProviderBudgetStatus;
    expect(tokenRangeLabel(status)).toContain('확인된 토큰 20 / 상한 100 (추정)');
    expect(tokenRangeLabel(status)).not.toContain('남음');
  });

  it('shows a recovery action for budget and clarification failures', () => {
    expect(
      nextAction({ failure: { code: 'CLAUDE_RUN_LIMIT_EXCEEDED', message: 'x' } } as Task),
    ).toContain('실행 한도를 높여');
    expect(
      nextAction({ failure: { code: 'CLARIFICATION_ROUNDS_EXCEEDED', message: 'x' } } as Task),
    ).toContain('누락된 내용');
  });
});
