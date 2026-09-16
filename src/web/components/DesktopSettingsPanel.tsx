import { useEffect, useState } from 'react';

import { desktopBridge, type DesktopAdapterMode, type DesktopSettings } from '../desktop-bridge.js';

export function DesktopSettingsPanel() {
  const bridge = desktopBridge;
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [version, setVersion] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!bridge) return;
    void Promise.all([bridge.getSettings(), bridge.getAppInfo()])
      .then(([loaded, info]) => {
        setSettings(loaded);
        setVersion(info.version);
      })
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      );
  }, [bridge]);

  if (!bridge || !settings) return null;

  const update = (patch: Partial<DesktopSettings>) =>
    setSettings((value) => ({ ...value!, ...patch }));
  const browse = async (provider: 'claude' | 'codex') => {
    const selected = await bridge.chooseExecutable(provider);
    if (selected) {
      update(
        provider === 'claude' ? { claudeExecutable: selected } : { codexExecutable: selected },
      );
    }
  };

  return (
    <details className="desktop-settings">
      <summary>앱 설정{version ? ` · v${version}` : ''}</summary>
      <p className="hint">처음에는 체험 모드를 사용하세요. 실제 모드는 설치된 AI를 실행합니다.</p>
      <AdapterSetting
        label="Claude"
        mode={settings.claudeAdapter}
        executable={settings.claudeExecutable}
        onMode={(mode) => update({ claudeAdapter: mode })}
        onExecutable={(value) => update({ claudeExecutable: value })}
        onBrowse={() => void browse('claude')}
      />
      <AdapterSetting
        label="Codex"
        mode={settings.codexAdapter}
        executable={settings.codexExecutable}
        onMode={(mode) => update({ codexAdapter: mode })}
        onExecutable={(value) => update({ codexExecutable: value })}
        onBrowse={() => void browse('codex')}
      />
      <button
        onClick={() => {
          setMessage('설정을 저장하고 앱을 다시 시작합니다…');
          void bridge
            .saveSettings(settings)
            .catch((error: unknown) =>
              setMessage(error instanceof Error ? error.message : String(error)),
            );
        }}
      >
        저장하고 다시 시작
      </button>
      {message && <p className="hint">{message}</p>}
    </details>
  );
}

function AdapterSetting({
  label,
  mode,
  executable,
  onMode,
  onExecutable,
  onBrowse,
}: {
  label: string;
  mode: DesktopAdapterMode;
  executable: string;
  onMode: (mode: DesktopAdapterMode) => void;
  onExecutable: (value: string) => void;
  onBrowse: () => void;
}) {
  return (
    <fieldset className="adapter-setting">
      <legend>{label}</legend>
      <label>
        모드
        <select value={mode} onChange={(event) => onMode(event.target.value as DesktopAdapterMode)}>
          <option value="fake">체험 모드</option>
          <option value="cli">실제 AI</option>
        </select>
      </label>
      {mode === 'cli' && (
        <label>
          실행 파일
          <span className="path-picker">
            <input value={executable} onChange={(event) => onExecutable(event.target.value)} />
            <button type="button" onClick={onBrowse}>
              찾기
            </button>
          </span>
        </label>
      )}
    </fieldset>
  );
}
