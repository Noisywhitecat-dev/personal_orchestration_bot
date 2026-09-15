import type { IsoTimestamp, ProjectId, RunId, SessionId, TaskId, UsageRecordId } from './ids.js';
import type { AgentProvider } from './run.js';

/**
 * `actual`      — numbers reported by the CLI itself.
 * `estimated`   — derived by us (e.g. character-count heuristics).
 * `unavailable` — the provider gave nothing; all token fields are null.
 */
export type UsageSource = 'actual' | 'estimated' | 'unavailable';

/** Raw token counts as reported in a single usage event. Unknown = null, never 0. */
export interface UsageSnapshot {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  source: UsageSource;
}

export const UNAVAILABLE_USAGE: UsageSnapshot = {
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  source: 'unavailable',
};

/** One persisted usage event. Aggregates are computed from these, never stored in place of them. */
export interface UsageRecord extends UsageSnapshot {
  id: UsageRecordId;
  provider: AgentProvider;
  projectId: ProjectId;
  taskId: TaskId;
  runId: RunId;
  sessionId: SessionId | null;
  recordedAt: IsoTimestamp;
}

export interface UsageTotals {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  recordCount: number;
  /** True if at least one contributing record is estimated. */
  hasEstimated: boolean;
  /** True if at least one contributing record reported nothing. */
  hasUnavailable: boolean;
}

export interface UsageSummary {
  claude: UsageTotals;
  codex: UsageTotals;
}

const EMPTY_TOTALS: UsageTotals = {
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  recordCount: 0,
  hasEstimated: false,
  hasUnavailable: false,
};

function addNullable(acc: number | null, value: number | null): number | null {
  if (value === null) return acc;
  return (acc ?? 0) + value;
}

/** Sum records for one provider. Null fields stay null if no record contributed a value. */
export function aggregateUsage(records: readonly UsageSnapshot[]): UsageTotals {
  let totals: UsageTotals = { ...EMPTY_TOTALS };
  for (const r of records) {
    totals = {
      inputTokens: addNullable(totals.inputTokens, r.inputTokens),
      cachedInputTokens: addNullable(totals.cachedInputTokens, r.cachedInputTokens),
      outputTokens: addNullable(totals.outputTokens, r.outputTokens),
      reasoningTokens: addNullable(totals.reasoningTokens, r.reasoningTokens),
      totalTokens: addNullable(totals.totalTokens, r.totalTokens),
      recordCount: totals.recordCount + 1,
      hasEstimated: totals.hasEstimated || r.source === 'estimated',
      hasUnavailable: totals.hasUnavailable || r.source === 'unavailable',
    };
  }
  return totals;
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  return {
    claude: aggregateUsage(records.filter((r) => r.provider === 'claude')),
    codex: aggregateUsage(records.filter((r) => r.provider === 'codex')),
  };
}
