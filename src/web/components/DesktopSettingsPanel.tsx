import {
  PRESETS,
  presetLimits,
  presetModels,
  selectedPreset,
  type Preset,
} from '../../shared/presets.js';
import { LimitSettings } from './LimitSettings.js';
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
  const [saved, setSaved] = useState('');
  const [advanced, setAdvanced] = useState(false);
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
        setSaved(JSON.stringify(loaded));
        setVersion(info.version);
        setCatalog(models);
      })
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      );
  }, [bridge]);

  if (!bridge)
    return (
      <p>
        웹 개발 모드입니다. 실제 AI 연결과 모델 설정은 데스크톱 앱의 앱 설정에서 변경하세요. 현재
        서버의 실행 모드는 상단에 표시됩니다.
      </p>
    );
  if (!settings || !catalog) return <p role="status">{message || '설정을 불러오는 중…'}</p>;

  const update = (patch: Partial<DesktopSettings>) =>
    setSettings((value) => ({ ...value!, ...patch }));
  const dirty = JSON.stringify(settings) !== saved;
  const preset = selectedPreset(settings, catalog);
  const browse = async (provider: 'claude' | 'codex') => {
    const selected = await bridge.chooseExecutable(provider);
    if (selected) {
      update(
        provider === 'claude' ? { claudeExecutable: selected } : { codexExecutable: selected },
      );
    }
  };

  return (
    <section className="desktop-settings">
      <h2>앱 설정{version ? ` · v${version}` : ''}</h2>
      <p className="hint">
        닫아도 편집 내용은 유지됩니다. 저장해야 적용되며 앱을 다시 시작하면 미저장 변경은
        사라집니다.
      </p>
      <h3>간편 설정</h3>
      <div className="preset-options" role="group" aria-label="간편 설정 프리셋">
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <button
            className="secondary"
            key={p}
            aria-pressed={preset === p}
            onClick={() =>
              update({
                ...presetModels(p, catalog),
                executionLimits: {
                  ...presetLimits(p),
                  claudeTokenCeiling: settings.executionLimits.claudeTokenCeiling,
                  codexTokenCeiling: settings.executionLimits.codexTokenCeiling,
                },
              })
            }
          >
            {PRESETS[p]}
          </button>
        ))}
      </div>
      <p className="preset-selection" role="status">
        선택: {preset ? PRESETS[preset] : '직접 설정'} ·{' '}
        {dirty ? '저장하지 않은 변경' : '저장된 설정'}
      </p>
      <p className="hint">
        프리셋은 모델·노력치와 실행 횟수를 제안합니다. 저장해도 AI 호출은 시작하지 않습니다. 토큰
        상한은 고급 설정에서 지정하세요.
      </p>
      <label>
        사용 모드
        <select
          value={
            settings.claudeAdapter === settings.codexAdapter ? settings.claudeAdapter : 'mixed'
          }
          onChange={(e) =>
            update({
              claudeAdapter: e.target.value as DesktopAdapterMode,
              codexAdapter: e.target.value as DesktopAdapterMode,
            })
          }
        >
          <option value="fake">체험 모드 · 토큰 사용 없음</option>
          <option value="cli">실제 AI · 요청 시 토큰 사용</option>
          <option value="mixed" disabled>
            고급 설정에서 각각 선택됨
          </option>
        </select>
      </label>
      <button
        className="text-button"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
      >
        모델·노력치 직접 설정 {advanced ? '접기' : '열기'}
      </button>
      {advanced && (
        <div className="advanced-settings">
          <p className="hint">
            처음에는 체험 모드를 사용하세요. 실제 모드는 설치된 AI를 실행합니다.
          </p>
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
          <LimitSettings
            value={settings.executionLimits}
            onChange={(executionLimits) => update({ executionLimits })}
          />
          <label>
            Claude 제한 시간 (분)
            <input
              type="number"
              min={1}
              max={120}
              value={settings.claudeTimeoutMs / 60000}
              onChange={(e) => update({ claudeTimeoutMs: Number(e.target.value) * 60000 })}
            />
          </label>
          <label>
            Codex 제한 시간 (분)
            <input
              type="number"
              min={1}
              max={120}
              value={settings.codexTimeoutMs / 60000}
              onChange={(e) => update({ codexTimeoutMs: Number(e.target.value) * 60000 })}
            />
          </label>
        </div>
      )}
      <p className="hint">
        저장하면 내장 서버가 다시 시작됩니다. 진행 중인 작업은 중단될 수 있고 자동으로 다시 호출하지
        않습니다.
      </p>
      <button
        disabled={saving || !dirty}
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
    </section>
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
            모델을 선택하면 실제 지원하는 노력치만 표시됩니다. CLI 기본 모델을 사용할 때는 노력치도
            CLI 기본값으로 유지합니다.
          </p>
        )}
        <p className="hint">모델 사용 가능 여부는 각 계정과 CLI 버전에 따라 달라집니다.</p>
      </>
      {mode === 'fake' && (
        <p className="hint">
          체험 모드에서는 위 모델을 호출하지 않습니다. 실제 AI로 전환한 뒤 저장할 때 적용됩니다.
        </p>
      )}
    </fieldset>
  );
}
