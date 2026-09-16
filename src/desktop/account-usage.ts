import {
  claudeStatusQuota,
  codexQuota,
  emptyAccountUsage,
  type AccountUsage,
  type QuotaWindow,
} from '../shared/account-usage.js';

/** Memory only. Keeps no credentials, paths, raw messages or account identifiers. */
export class AccountUsageStore {
  private value = emptyAccountUsage();
  private pending: Promise<AccountUsage> | null = null;
  private generation = 0;
  private queriedAt = -Infinity;
  snapshot = () => structuredClone(this.value);
  clear() {
    this.generation++;
    this.value = emptyAccountUsage();
    this.pending = null;
    this.queriedAt = -Infinity;
  }
  observe(windows: QuotaWindow[]) {
    for (const next of windows)
      this.value.claude = [...this.value.claude.filter((w) => w.kind !== next.kind), next];
  }
  importStatus(text: unknown) {
    if (typeof text !== 'string' || text.length > 65536)
      throw new Error('64KB 이하의 상태 표시줄 JSON 파일을 선택하세요.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('JSON 파일 형식이 올바르지 않습니다.');
    }
    const windows = claudeStatusQuota(parsed);
    if (!windows.length) throw new Error('rate_limits에 유효한 5시간 또는 주간 사용량이 없습니다.');
    this.value.claude = windows;
    return this.snapshot();
  }
  refresh(query: () => Promise<unknown>) {
    if (this.pending) return this.pending;
    if (Date.now() - this.queriedAt < 15000) return Promise.resolve(this.snapshot());
    const generation = this.generation;
    this.queriedAt = Date.now();
    const pending = query()
      .then((value) => {
        if (generation === this.generation) {
          this.value.codex = codexQuota(value);
          this.value.codexStatus = this.value.codex.length ? 'available' : 'unavailable';
        }
      })
      .catch(() => {
        if (generation === this.generation) {
          this.value.codex = [];
          this.value.codexStatus = 'unavailable';
        }
      })
      .then(() => this.snapshot())
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
}
