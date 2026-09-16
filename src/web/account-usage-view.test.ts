import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./desktop-bridge.js', () => ({ desktopBridge: undefined }));
import { Quota } from './components/AccountUsagePanel.js';
import type { QuotaWindow } from '../shared/account-usage.js';

describe('account usage labels', () => {
  const window: QuotaWindow = {
    kind: 'seven_day',
    usedPercent: 0,
    resetsAt: 1000,
    observedAt: 100,
    source: 'import',
  };
  const render = (windows: QuotaWindow[], now: number) =>
    renderToStaticMarkup(
      createElement(Quota, { label: 'Claude 주간', kind: 'seven_day', windows, now }),
    );
  it('shows zero only when reported and labels imported snapshots explicitly', () => {
    expect(render([], 0)).toContain('확인 불가');
    expect(render([], 0)).not.toContain('<progress');
    const html = render([window], 0);
    expect(html).toContain('0% 사용');
    expect(html).toContain('파일에서 가져옴');
    expect(html).toContain('초기화:');
  });
  it('does not present an expired window as current available capacity', () => {
    const html = render([window], 1000000);
    expect(html).toContain('초기화 시각 경과');
    expect(html).not.toContain('% 남음');
    expect(html).not.toContain('<progress');
    expect(render([{ ...window, resetsAt: null }], 0)).toContain('확인 불가');
  });
});
