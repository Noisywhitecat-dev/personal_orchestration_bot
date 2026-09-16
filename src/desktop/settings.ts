import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type DesktopAdapterMode = 'fake' | 'cli';

export interface DesktopSettings {
  claudeAdapter: DesktopAdapterMode;
  codexAdapter: DesktopAdapterMode;
  claudeExecutable: string;
  codexExecutable: string;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  claudeAdapter: 'fake',
  codexAdapter: 'fake',
  claudeExecutable: 'claude',
  codexExecutable: 'codex',
};

function adapterMode(value: unknown): DesktopAdapterMode {
  return value === 'cli' ? 'cli' : 'fake';
}

function executable(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 2_000 ? normalized : fallback;
}

export function parseDesktopSettings(value: unknown): DesktopSettings {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    claudeAdapter: adapterMode(input['claudeAdapter']),
    codexAdapter: adapterMode(input['codexAdapter']),
    claudeExecutable: executable(input['claudeExecutable'], 'claude'),
    codexExecutable: executable(input['codexExecutable'], 'codex'),
  };
}

export function loadDesktopSettings(path: string): DesktopSettings {
  if (!existsSync(path)) return { ...DEFAULT_DESKTOP_SETTINGS };
  try {
    return parseDesktopSettings(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export function saveDesktopSettings(path: string, value: unknown): DesktopSettings {
  const settings = parseDesktopSettings(value);
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
  };
}
