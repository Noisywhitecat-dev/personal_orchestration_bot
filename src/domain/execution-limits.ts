import type { AgentProvider, Run } from './run.js';
import type { Task } from './task.js';
import type { UsageRecord, UsageSource } from './usage.js';

export const DEFAULT_MAX_CLAUDE_RUNS = 6;
export const DEFAULT_MAX_CODEX_RUNS = 3;
export const DEFAULT_MAX_CLARIFICATION_ROUNDS = 3;

export interface ExecutionLimitsInput {
  maxClaudeRuns: number;
  maxCodexRuns: number;
  claudeTokenCeiling: number | null;
  codexTokenCeiling: number | null;
  maxClarificationRounds: number;
  maxReviewRounds: number;
}

export type TokenConfidence = 'actual' | 'estimated' | 'unavailable' | 'unlimited';

export interface ProviderBudgetStatus {
  maxRuns: number;
  usedRuns: number;
  remainingRuns: number;
  tokenCeiling: number | null;
  knownTokens: number;
  /** Only populated when every recorded total is actual. */
  reliableRemainingTokens: number | null;
  tokenConfidence: TokenConfidence;
}

export interface ExecutionBudgetStatus {
  claude: ProviderBudgetStatus;
  codex: ProviderBudgetStatus;
}

export interface BudgetFailure {
  code: string;
  message: string;
}

export function limitsFromTask(task: Task): ExecutionLimitsInput {
  return {
    maxClaudeRuns: task.maxClaudeRuns,
    maxCodexRuns: task.maxCodexRuns,
    claudeTokenCeiling: task.claudeTokenCeiling,
    codexTokenCeiling: task.codexTokenCeiling,
    maxClarificationRounds: task.maxClarificationRounds,
    maxReviewRounds: task.maxReviewRounds,
  };
}

export function executionBudgetStatus(
  task: Task,
  runs: readonly Run[],
  usage: readonly UsageRecord[],
): ExecutionBudgetStatus {
  return {
    claude: providerStatus('claude', task, runs, usage),
    codex: providerStatus('codex', task, runs, usage),
  };
}

export function budgetFailureFor(
  provider: AgentProvider,
  task: Task,
  runs: readonly Run[],
  usage: readonly UsageRecord[],
): BudgetFailure | null {
  const status = providerStatus(provider, task, runs, usage);
  const label = provider === 'claude' ? 'Claude' : 'Codex';
  if (status.usedRuns >= status.maxRuns) {
    return {
      code: provider === 'claude' ? 'CLAUDE_RUN_LIMIT_EXCEEDED' : 'CODEX_RUN_LIMIT_EXCEEDED',
      message: `${label} run limit reached (${status.usedRuns}/${status.maxRuns}). Increase the task limit and submit a new task.`,
    };
  }
  if (status.tokenCeiling !== null && status.knownTokens >= status.tokenCeiling) {
    return {
      code: provider === 'claude' ? 'CLAUDE_TOKEN_CEILING_REACHED' : 'CODEX_TOKEN_CEILING_REACHED',
      message: `${label} run-boundary token ceiling reached (${status.knownTokens}/${status.tokenCeiling}). No provider call was started.`,
    };
  }
  return null;
}

function providerStatus(
  provider: AgentProvider,
  task: Task,
  runs: readonly Run[],
  usage: readonly UsageRecord[],
): ProviderBudgetStatus {
  const providerRuns = runs.filter((run) => run.provider === provider);
  const providerUsage = usage.filter((record) => record.provider === provider);
  const maxRuns = provider === 'claude' ? task.maxClaudeRuns : task.maxCodexRuns;
  const tokenCeiling = provider === 'claude' ? task.claudeTokenCeiling : task.codexTokenCeiling;
  const knownTokens = providerUsage.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0);
  const confidence = confidenceFor(
    providerUsage.map((record) => record.source),
    tokenCeiling,
  );
  return {
    maxRuns,
    usedRuns: providerRuns.length,
    remainingRuns: Math.max(0, maxRuns - providerRuns.length),
    tokenCeiling,
    knownTokens,
    reliableRemainingTokens:
      tokenCeiling !== null && confidence === 'actual'
        ? Math.max(0, tokenCeiling - knownTokens)
        : null,
    tokenConfidence: confidence,
  };
}

function confidenceFor(sources: readonly UsageSource[], ceiling: number | null): TokenConfidence {
  if (ceiling === null) return 'unlimited';
  if (sources.includes('unavailable')) return 'unavailable';
  if (sources.includes('estimated')) return 'estimated';
  return 'actual';
}
