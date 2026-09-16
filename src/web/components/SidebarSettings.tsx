import { useEffect, useState } from 'react';
import type { RuntimeStatusResponse } from '../../shared/contracts.js';
import { desktopBridge, type DesktopSettings } from '../desktop-bridge.js';
import { AccountUsagePanel } from './AccountUsagePanel.js';

export function SidebarSettings({
  runtime,
  onSettings,
}: {
  runtime: RuntimeStatusResponse | null;
  onSettings: () => void;
}) {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  useEffect(() => {
    void desktopBridge
      ?.getSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);
  return (
    <div className="sidebar-settings">
      <section aria-label="현재 모델과 노력치">
        <div className="section-heading">
          <h2>모델 · 노력치</h2>
          <button className="text-button" onClick={onSettings}>
            변경
          </button>
        </div>
        {(['claude', 'codex'] as const).map((provider) => {
          const config = runtime?.[provider];
          const model =
            settings?.[provider === 'claude' ? 'claudeModel' : 'codexModel'] ?? config?.model;
          const effort =
            settings?.[provider === 'claude' ? 'claudeEffort' : 'codexEffort'] ?? config?.effort;
          return (
            <p className="sidebar-model" key={provider}>
              <strong>{provider === 'claude' ? 'Claude' : 'Codex'}</strong>
              <span>
                {model || 'CLI 기본 모델'} · {effort || '기본 노력치'}
              </span>
              {config?.adapter === 'fake' && <small>체험 모드 · 실제 AI 실행 안 함</small>}
              {!config && <small>연결 중</small>}
            </p>
          );
        })}
      </section>
      <AccountUsagePanel compact />
    </div>
  );
}
