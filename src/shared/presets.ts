import type { ExecutionLimitsInput } from '../domain/execution-limits.js';
import { compatibleSelection, type ModelCatalog } from './model-catalog.js';

export const PRESETS = {
  auto: '자동',
  economy: '절약',
  balanced: '균형',
  quality: '품질 우선',
} as const;
export type Preset = keyof typeof PRESETS;
export function presetLimits(preset: Preset): ExecutionLimitsInput {
  return {
    maxClaudeRuns: preset === 'economy' ? 3 : preset === 'quality' ? 8 : 6,
    maxCodexRuns: preset === 'economy' ? 1 : preset === 'quality' ? 4 : 3,
    maxClarificationRounds: preset === 'economy' ? 1 : 3,
    maxReviewRounds: preset === 'economy' ? 1 : preset === 'quality' ? 3 : 2,
    claudeTokenCeiling: null,
    codexTokenCeiling: null,
  };
}
export function presetModels(preset: Preset, catalog: ModelCatalog) {
  const effort = preset === 'economy' ? 'low' : preset === 'quality' ? 'high' : 'medium';
  const claude = compatibleSelection(
    'claude',
    preset === 'auto' ? '' : preset === 'quality' ? 'opus' : 'sonnet',
    effort,
    catalog,
  );
  const codex = compatibleSelection(
    'codex',
    preset === 'auto'
      ? ''
      : ((catalog.codex.find((m) => m.id === 'gpt-5.6-sol') ?? catalog.codex[0])?.id ?? ''),
    effort,
    catalog,
  );
  return {
    claudeModel: claude.model,
    claudeEffort: claude.effort,
    codexModel: codex.model,
    codexEffort: codex.effort,
  };
}
