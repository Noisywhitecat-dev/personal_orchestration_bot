import { describe, expect, it } from 'vitest';

import type { ProviderBudgetStatus, Task } from '../shared/contracts.js';
import { nextAction, tokenRangeLabel } from './view-model.js';

describe('web view model', () => {
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
