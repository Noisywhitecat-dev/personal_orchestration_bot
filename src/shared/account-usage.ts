export type QuotaKind = 'five_hour' | 'seven_day';
export interface QuotaWindow {
  kind: QuotaKind;
  usedPercent: number;
  resetsAt: number | null;
  observedAt: number;
  source: 'codex' | 'claude_event' | 'import';
}
export interface AccountUsage {
  codex: QuotaWindow[];
  claude: QuotaWindow[];
  codexStatus: 'not_loaded' | 'available' | 'unavailable';
}
export const emptyAccountUsage = (): AccountUsage => ({
  codex: [],
  claude: [],
  codexStatus: 'not_loaded',
});

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function window(
  kind: QuotaKind,
  used: unknown,
  reset: unknown,
  source: QuotaWindow['source'],
  now: number,
): QuotaWindow | null {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const resetsAt =
    typeof reset === 'number' && Number.isSafeInteger(reset) && reset > 0 && reset < 8640000000000
      ? reset
      : null;
  return { kind, usedPercent: used, resetsAt, source, observedAt: now };
}
export function codexQuota(value: unknown, now = Date.now()): QuotaWindow[] {
  const data = record(value);
  // Do not mistake another model's limit bucket for the account's Codex allowance.
  const all = record(data['rateLimitsByLimitId']);
  const legacy = record(data['rateLimits']);
  const bucket = record(
    Object.keys(all).length
      ? all['codex']
      : !legacy['limitId'] || legacy['limitId'] === 'codex'
        ? legacy
        : null,
  );
  return ['primary', 'secondary'].flatMap((key) => {
    const w = record(bucket[key]);
    const kind =
      w['windowDurationMins'] === 10080
        ? 'seven_day'
        : w['windowDurationMins'] === 300
          ? 'five_hour'
          : null;
    const parsed = kind && window(kind, w['usedPercent'], w['resetsAt'], 'codex', now);
    return parsed ? [parsed] : [];
  });
}
export function claudeStatusQuota(value: unknown, now = Date.now()): QuotaWindow[] {
  const limits = record(record(value)['rate_limits']);
  return (['five_hour', 'seven_day'] as const).flatMap((kind) => {
    const w = record(limits[kind]);
    const parsed = window(kind, w['used_percentage'], w['resets_at'], 'import', now);
    return parsed ? [parsed] : [];
  });
}
export function claudeEventQuota(line: string, now = Date.now()): QuotaWindow[] {
  if (line.length > 65536) return [];
  try {
    const data = record(JSON.parse(line));
    if (data['type'] !== 'rate_limit_event') return [];
    const info = record(data['rate_limit_info']);
    const kind = info['rateLimitType'] ?? info['rate_limit_type'];
    if (kind !== 'five_hour' && kind !== 'seven_day') return [];
    const fraction = info['utilization'];
    const parsed = window(
      kind,
      typeof fraction === 'number' ? fraction * 100 : null,
      info['resetsAt'] ?? info['resets_at'],
      'claude_event',
      now,
    );
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}
