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
    expect(tokenRangeLabel(status)).toContain('20 known / 100 ceiling (estimated)');
    expect(tokenRangeLabel(status)).not.toContain('remain');
  });

  it('shows a recovery action for budget and clarification failures', () => {
    expect(
      nextAction({ failure: { code: 'CLAUDE_RUN_LIMIT_EXCEEDED', message: 'x' } } as Task),
    ).toContain('higher execution limit');
    expect(
      nextAction({ failure: { code: 'CLARIFICATION_ROUNDS_EXCEEDED', message: 'x' } } as Task),
    ).toContain('missing details');
  });
});
