import { describe, expect, it } from 'vitest';

import { budgetFailureFor, executionBudgetStatus } from './execution-limits.js';
import type { Run } from './run.js';
import type { Task } from './task.js';
import type { UsageRecord } from './usage.js';

const task = {
  maxClaudeRuns: 2,
  maxCodexRuns: 2,
  claudeTokenCeiling: 100,
  codexTokenCeiling: null,
} as Task;

const run = (provider: 'claude' | 'codex', n: number): Run => ({ id: `run-${n}`, provider }) as Run;
const usage = (source: 'actual' | 'estimated' | 'unavailable', total: number | null): UsageRecord =>
  ({ provider: 'claude', source, totalTokens: total }) as UsageRecord;

describe('execution budgets', () => {
  it('blocks a run count before another provider run can start', () => {
    const runs = [run('claude', 1), run('claude', 2)];
    expect(budgetFailureFor('claude', task, runs, [])?.code).toBe('CLAUDE_RUN_LIMIT_EXCEEDED');
  });

  it('blocks when the known cumulative total has reached the run-boundary ceiling', () => {
    expect(budgetFailureFor('claude', task, [], [usage('actual', 100)])?.code).toBe(
      'CLAUDE_TOKEN_CEILING_REACHED',
    );
  });

  it('treats null ceilings as unlimited', () => {
    const status = executionBudgetStatus(task, [], []).codex;
    expect(status.tokenConfidence).toBe('unlimited');
    expect(status.reliableRemainingTokens).toBeNull();
    expect(budgetFailureFor('codex', task, [], [])).toBeNull();
  });

  it('does not present estimated or unavailable usage as reliable remaining tokens', () => {
    expect(executionBudgetStatus(task, [], [usage('estimated', 20)]).claude).toMatchObject({
      knownTokens: 20,
      tokenConfidence: 'estimated',
      reliableRemainingTokens: null,
    });
    expect(executionBudgetStatus(task, [], [usage('unavailable', null)]).claude).toMatchObject({
      knownTokens: 0,
      tokenConfidence: 'unavailable',
      reliableRemainingTokens: null,
    });
  });
});
