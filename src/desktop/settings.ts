import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import {
  compatibleSelection,
  DEFAULT_MODEL_CATALOG,
  type ModelCatalog,
  type ModelEffort,
} from '../shared/model-catalog.js';

export type DesktopAdapterMode = 'fake' | 'cli';
export type ClaudeEffort = '' | ModelEffort;
export type CodexEffort = '' | ModelEffort;

export interface DesktopSettings {
  claudeAdapter: DesktopAdapterMode;
  codexAdapter: DesktopAdapterMode;
  claudeExecutable: string;
  codexExecutable: string;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  codexModel: string;
  codexEffort: CodexEffort;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  claudeAdapter: 'fake',
  codexAdapter: 'fake',
  claudeExecutable: 'claude',
  codexExecutable: 'codex',
  claudeModel: '',
  claudeEffort: '',
  codexModel: '',
  codexEffort: '',
};

function adapterMode(value: unknown): DesktopAdapterMode {
  return value === 'cli' ? 'cli' : 'fake';
}

function executable(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 2_000 ? normalized : fallback;
}

function model(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized) ? normalized : '';
}

export function parseDesktopSettings(
  value: unknown,
  catalog: ModelCatalog = DEFAULT_MODEL_CATALOG,
): DesktopSettings {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const claude = compatibleSelection(
    'claude',
    model(input['claudeModel']),
    input['claudeEffort'],
    catalog,
  );
  const codex = compatibleSelection(
    'codex',
    model(input['codexModel']),
    input['codexEffort'],
    catalog,
  );
  return {
    claudeAdapter: adapterMode(input['claudeAdapter']),
    codexAdapter: adapterMode(input['codexAdapter']),
    claudeExecutable: executable(input['claudeExecutable'], 'claude'),
    codexExecutable: executable(input['codexExecutable'], 'codex'),
    claudeModel: claude.model,
    claudeEffort: claude.effort,
    codexModel: codex.model,
    codexEffort: codex.effort,
  };
}

export function loadDesktopSettings(
  path: string,
  catalog: ModelCatalog = DEFAULT_MODEL_CATALOG,
): DesktopSettings {
  if (!existsSync(path)) return { ...DEFAULT_DESKTOP_SETTINGS };
  try {
    return parseDesktopSettings(JSON.parse(readFileSync(path, 'utf8')) as unknown, catalog);
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export function saveDesktopSettings(
  path: string,
  value: unknown,
  catalog: ModelCatalog = DEFAULT_MODEL_CATALOG,
): DesktopSettings {
  const settings = parseDesktopSettings(value, catalog);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return settings;
}

export function desktopEnvironment(
  settings: DesktopSettings,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CLAUDE_ADAPTER: settings.claudeAdapter,
    CODEX_ADAPTER: settings.codexAdapter,
    CLAUDE_EXECUTABLE: settings.claudeExecutable,
    CODEX_EXECUTABLE: settings.codexExecutable,
    ...(settings.claudeModel ? { CLAUDE_MODEL: settings.claudeModel } : {}),
    ...(settings.claudeEffort ? { CLAUDE_EFFORT: settings.claudeEffort } : {}),
    ...(settings.codexModel ? { CODEX_MODEL: settings.codexModel } : {}),
    ...(settings.codexEffort ? { CODEX_REASONING_EFFORT: settings.codexEffort } : {}),
  };
}
