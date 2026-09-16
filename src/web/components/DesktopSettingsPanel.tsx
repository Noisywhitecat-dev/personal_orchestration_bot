import { useEffect, useState } from 'react';

import type { ModelCatalog, ModelSpec } from '../../shared/model-catalog.js';
import {
  desktopBridge,
  type ClaudeEffort,
  type CodexEffort,
  type DesktopAdapterMode,
  type DesktopSettings,
} from '../desktop-bridge.js';

export function DesktopSettingsPanel() {
  const bridge = desktopBridge;
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [version, setVersion] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void Promise.all([bridge.getSettings(), bridge.getAppInfo(), bridge.getModelCatalog()])
      .then(([loaded, info, models]) => {
        setSettings(loaded);
        setVersion(info.version);
        setCatalog(models);
      })
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      );
  }, [bridge]);

  if (!bridge || !settings || !catalog) return null;

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
        model={settings.claudeModel}
        effort={settings.claudeEffort}
        models={catalog.claude}
        onMode={(mode) => update({ claudeAdapter: mode })}
        onExecutable={(value) => update({ claudeExecutable: value })}
        onModel={(value) => update({ claudeModel: value, claudeEffort: '' })}
        onEffort={(value) => update({ claudeEffort: value as ClaudeEffort })}
        onBrowse={() => void browse('claude')}
      />
      <AdapterSetting
        label="Codex"
        mode={settings.codexAdapter}
        executable={settings.codexExecutable}
        model={settings.codexModel}
        effort={settings.codexEffort}
        models={catalog.codex}
        onMode={(mode) => update({ codexAdapter: mode })}
        onExecutable={(value) => update({ codexExecutable: value })}
        onModel={(value) => update({ codexModel: value, codexEffort: '' })}
        onEffort={(value) => update({ codexEffort: value as CodexEffort })}
        onBrowse={() => void browse('codex')}
      />
      <button
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setMessage('설정을 저장하고 적용하는 중입니다…');
          void bridge.saveSettings(settings).catch((error: unknown) => {
            setSaving(false);
            setMessage(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        {saving ? '적용 중…' : '저장하고 다시 시작'}
      </button>
      {message && <p className="hint">{message}</p>}
    </details>
  );
}

function AdapterSetting({
  label,
  mode,
  executable,
  model,
  effort,
  models,
  onMode,
  onExecutable,
  onModel,
  onEffort,
  onBrowse,
}: {
  label: string;
  mode: DesktopAdapterMode;
  executable: string;
  model: string;
  effort: string;
  models: ModelSpec[];
  onMode: (mode: DesktopAdapterMode) => void;
  onExecutable: (value: string) => void;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onBrowse: () => void;
}) {
  const selectedModel = models.find((candidate) => candidate.id === model);
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
        <>
          <label>
            실행 파일
            <span className="path-picker">
              <input value={executable} onChange={(event) => onExecutable(event.target.value)} />
              <button type="button" onClick={onBrowse}>
                찾기
              </button>
            </span>
          </label>
          <label>
            모델
            <select value={model} onChange={(event) => onModel(event.target.value)}>
              <option value="">CLI 기본값 사용</option>
              {models.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            노력치
            <select
              value={effort}
              disabled={!selectedModel}
              onChange={(event) => onEffort(event.target.value)}
            >
              <option value="">CLI 기본값</option>
              {(selectedModel?.efforts ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          {selectedModel ? (
            <p className="hint">
              이 모델의 CLI 기본값: {selectedModel.defaultEffort ?? '모델 기본값'} · 일반 개발 권장:{' '}
              {selectedModel.recommendedEffort}
              <br />
              단순 작업은 low, 일반 작업은 medium, 복잡한 디버깅·리팩터링은 high 이상을 참고하세요.
            </p>
          ) : (
            <p className="hint">
              모델을 선택하면 실제 지원하는 노력치만 표시됩니다. CLI 기본 모델을 사용할 때는
              노력치도 CLI 기본값으로 유지합니다.
            </p>
          )}
          <p className="hint">모델 사용 가능 여부는 각 계정과 CLI 버전에 따라 달라집니다.</p>
        </>
      )}
    </fieldset>
  );
}
