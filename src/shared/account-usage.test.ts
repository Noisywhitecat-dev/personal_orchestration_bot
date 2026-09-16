import { describe, expect, it } from 'vitest';
import { claudeEventQuota, claudeStatusQuota, codexQuota } from './account-usage.js';
import { AccountUsageStore } from '../desktop/account-usage.js';
import { DEFAULT_MODEL_CATALOG } from './model-catalog.js';
import { presetLimits, presetModels, selectedPreset } from './presets.js';

describe('subscription usage', () => {
  it('selects the codex bucket by duration and never labels missing data as zero', () => {
    const quota = codexQuota(
      {
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1800000000 },
            secondary: { usedPercent: 2, windowDurationMins: 300 },
          },
          other: { secret: 'PRIVATE' },
        },
      },
      100,
    );
    expect(quota).toEqual([
      {
        kind: 'seven_day',
        usedPercent: 45,
        resetsAt: 1800000000,
        observedAt: 100,
        source: 'codex',
      },
      { kind: 'five_hour', usedPercent: 2, resetsAt: null, observedAt: 100, source: 'codex' },
    ]);
    for (const value of [
      null,
      {},
      { rateLimitsByLimitId: { other: {} } },
      { rateLimits: { secondary: { usedPercent: null, windowDurationMins: 10080 } } },
    ])
      expect(codexQuota(value)).toEqual([]);
    expect(
      codexQuota({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10080 } } })[0]
        ?.usedPercent,
    ).toBe(0);
  });
  it('extracts only known Claude windows, strips secrets and rejects invalid percentages', () => {
    const value = {
      session_id: 'PRIVATE',
      rate_limits: {
        five_hour: { used_percentage: 12.5, resets_at: 1800000000, token: 'PRIVATE' },
        seven_day: { used_percentage: 102 },
        other: { used_percentage: 10 },
      },
    };
    expect(JSON.stringify(claudeStatusQuota(value))).not.toContain('PRIVATE');
    expect(claudeStatusQuota(value)).toHaveLength(1);
    expect(
      claudeEventQuota(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.25, resetsAt: 1800000000 },
          session_id: 'PRIVATE',
        }),
      )[0],
    ).toMatchObject({ kind: 'seven_day', usedPercent: 25, source: 'claude_event' });
    expect(claudeEventQuota('{bad')).toEqual([]);
    expect(
      claudeEventQuota(
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.9 } }),
      ),
    ).toEqual([]);
  });
  it('coalesces reads, sanitizes imported data, and ignores an old account response after clearing', async () => {
    const store = new AccountUsageStore();
    expect(store.snapshot().codexStatus).toBe('not_loaded');
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const query = () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    };
    const first = store.refresh(query),
      second = store.refresh(query);
    expect(calls).toBe(1);
    store.clear();
    resolve({ rateLimits: { primary: { windowDurationMins: 10080, usedPercent: 45 } } });
    await Promise.all([first, second]);
    expect(store.snapshot().codex).toEqual([]);
    expect(() => store.importStatus('PRIVATE')).toThrow();
    expect(() => store.importStatus('a'.repeat(65537))).toThrow();
    store.importStatus(
      JSON.stringify({ secret: 'PRIVATE', rate_limits: { five_hour: { used_percentage: 50 } } }),
    );
    expect(JSON.stringify(store.snapshot())).not.toContain('PRIVATE');
    await store.refresh(async () => {
      throw new Error('PRIVATE');
    });
    expect(store.snapshot().codexStatus).toBe('unavailable');
  });
  it('restores preset selection from saved values and identifies individual model/effort changes', () => {
    const settings = {
      ...presetModels('balanced', DEFAULT_MODEL_CATALOG),
      executionLimits: { ...presetLimits('balanced'), claudeTokenCeiling: 5000 },
    };
    expect(selectedPreset(settings, DEFAULT_MODEL_CATALOG)).toBe('balanced');
    expect(selectedPreset({ ...settings, codexEffort: 'high' }, DEFAULT_MODEL_CATALOG)).toBeNull();
  });
});
