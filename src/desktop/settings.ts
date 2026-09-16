import type { ExecutionLimitsInput } from '../domain/execution-limits.js';
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
  executionLimits: ExecutionLimitsInput;
  claudeTimeoutMs: number;
  codexTimeoutMs: number;
  onboardingCompleted: boolean;
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
  executionLimits: {
    maxClaudeRuns: 6,
    maxCodexRuns: 3,
    maxClarificationRounds: 3,
    maxReviewRounds: 2,
    claudeTokenCeiling: null,
    codexTokenCeiling: null,
  },
  claudeTimeoutMs: 600000,
  codexTimeoutMs: 900000,
  onboardingCompleted: false,
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
  const integer = (value: unknown, fallback: number, max: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
      ? value
      : fallback;
  const limits =
    input['executionLimits'] && typeof input['executionLimits'] === 'object'
      ? (input['executionLimits'] as Record<string, unknown>)
      : {};
  const defaults = DEFAULT_DESKTOP_SETTINGS.executionLimits;
  const ceiling = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  return {
    executionLimits: {
      maxClaudeRuns: integer(limits['maxClaudeRuns'], defaults.maxClaudeRuns, 100),
      maxCodexRuns: integer(limits['maxCodexRuns'], defaults.maxCodexRuns, 100),
      maxClarificationRounds: integer(
        limits['maxClarificationRounds'],
        defaults.maxClarificationRounds,
        20,
      ),
      maxReviewRounds: integer(limits['maxReviewRounds'], defaults.maxReviewRounds, 20),
      claudeTokenCeiling: ceiling(limits['claudeTokenCeiling']),
      codexTokenCeiling: ceiling(limits['codexTokenCeiling']),
    },
    claudeTimeoutMs: integer(input['claudeTimeoutMs'], 600000, 7200000),
    codexTimeoutMs: integer(input['codexTimeoutMs'], 900000, 7200000),
    onboardingCompleted: input['onboardingCompleted'] === true,
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
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return parseDesktopSettings(
      { ...value, onboardingCompleted: value['onboardingCompleted'] ?? true },
      catalog,
    );
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
    CLAUDE_MODEL: settings.claudeModel,
    CLAUDE_TIMEOUT_MS: String(settings.claudeTimeoutMs),
    CODEX_TIMEOUT_MS: String(settings.codexTimeoutMs),
    MAX_CLAUDE_RUNS: String(settings.executionLimits.maxClaudeRuns),
    MAX_CODEX_RUNS: String(settings.executionLimits.maxCodexRuns),
    MAX_CLARIFICATION_ROUNDS: String(settings.executionLimits.maxClarificationRounds),
    MAX_REVIEW_ROUNDS: String(settings.executionLimits.maxReviewRounds),
    CLAUDE_TOKEN_CEILING:
      settings.executionLimits.claudeTokenCeiling === null
        ? ''
        : String(settings.executionLimits.claudeTokenCeiling),
    CODEX_TOKEN_CEILING:
      settings.executionLimits.codexTokenCeiling === null
        ? ''
        : String(settings.executionLimits.codexTokenCeiling),
    CLAUDE_EFFORT: settings.claudeEffort,
    CODEX_MODEL: settings.codexModel,
    CODEX_REASONING_EFFORT: settings.codexEffort,
  };
}
