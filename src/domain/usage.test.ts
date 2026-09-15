import { describe, expect, it } from 'vitest';

import { asProjectId, asRunId, asTaskId, asUsageRecordId } from './ids.js';
import type { AgentProvider } from './run.js';
import {
  UNAVAILABLE_USAGE,
  aggregateUsage,
  summarizeUsage,
  type UsageRecord,
  type UsageSnapshot,
} from './usage.js';

function record(provider: AgentProvider, snap: Partial<UsageSnapshot>, n: number): UsageRecord {
  return {
    id: asUsageRecordId(`u-${n}`),
    provider,
    projectId: asProjectId('p'),
    taskId: asTaskId('t'),
    runId: asRunId(`r-${n}`),
    sessionId: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...UNAVAILABLE_USAGE,
    ...snap,
  };
}

describe('aggregateUsage', () => {
  it('returns nulls and zero count for no records', () => {
    const t = aggregateUsage([]);
    expect(t.totalTokens).toBeNull();
    expect(t.inputTokens).toBeNull();
    expect(t.recordCount).toBe(0);
    expect(t.hasEstimated).toBe(false);
    expect(t.hasUnavailable).toBe(false);
  });

  it('sums actual values', () => {
    const t = aggregateUsage([
      { ...UNAVAILABLE_USAGE, inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'actual' },
      { ...UNAVAILABLE_USAGE, inputTokens: 20, outputTokens: 1, totalTokens: 21, source: 'actual' },
    ]);
    expect(t).toMatchObject({ inputTokens: 30, outputTokens: 6, totalTokens: 36, recordCount: 2 });
    expect(t.cachedInputTokens).toBeNull();
    expect(t.reasoningTokens).toBeNull();
  });

  it('never turns unknown into 0 and flags unavailable/estimated', () => {
    const t = aggregateUsage([
      UNAVAILABLE_USAGE,
      { ...UNAVAILABLE_USAGE, totalTokens: 7, source: 'estimated' },
    ]);
    expect(t.totalTokens).toBe(7);
    expect(t.inputTokens).toBeNull();
    expect(t.hasUnavailable).toBe(true);
    expect(t.hasEstimated).toBe(true);
  });
});

describe('summarizeUsage', () => {
  it('splits by provider', () => {
    const s = summarizeUsage([
      record('claude', { totalTokens: 100, source: 'actual' }, 1),
      record('codex', { totalTokens: 200, source: 'estimated' }, 2),
      record('codex', { totalTokens: 50, source: 'actual' }, 3),
    ]);
    expect(s.claude.totalTokens).toBe(100);
    expect(s.claude.hasEstimated).toBe(false);
    expect(s.codex.totalTokens).toBe(250);
    expect(s.codex.recordCount).toBe(2);
    expect(s.codex.hasEstimated).toBe(true);
  });
});
