import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_MODEL_CATALOG,
  FALLBACK_CODEX_MODEL_CATALOG,
  isModelEffort,
  type ModelCatalog,
  type ModelEffort,
  type ModelSpec,
} from '../shared/model-catalog.js';

export function loadDesktopModelCatalog(env: NodeJS.ProcessEnv = process.env): ModelCatalog {
  const codexHome = env['CODEX_HOME'] || join(env['USERPROFILE'] || homedir(), '.codex');
  const cachePath = join(codexHome, 'models_cache.json');
  const codex = readCodexModels(cachePath);
  return {
    claude: CLAUDE_MODEL_CATALOG,
    codex: codex.length > 0 ? codex : FALLBACK_CODEX_MODEL_CATALOG,
  };
}

function readCodexModels(path: string): ModelSpec[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObject(parsed) || !Array.isArray(parsed['models'])) return [];
    return parsed['models'].flatMap((value) => parseCodexModel(value));
  } catch {
    return [];
  }
}

function parseCodexModel(value: unknown): ModelSpec[] {
  if (!isObject(value) || value['visibility'] !== 'list') return [];
  const id = value['slug'];
  const label = value['display_name'];
  const levels = value['supported_reasoning_levels'];
  if (typeof id !== 'string' || typeof label !== 'string' || !Array.isArray(levels)) return [];
  const efforts = levels
    .map((level) => (isObject(level) ? level['effort'] : undefined))
    .filter(isModelEffort);
  if (efforts.length === 0) return [];
  const defaultEffort = isModelEffort(value['default_reasoning_level'])
    ? value['default_reasoning_level']
    : null;
  return [
    {
      id,
      label,
      efforts,
      defaultEffort,
      recommendedEffort: recommendedEffort(efforts, defaultEffort),
    },
  ];
}

function recommendedEffort(efforts: ModelEffort[], defaultEffort: ModelEffort | null): ModelEffort {
  if (efforts.includes('medium')) return 'medium';
  return defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : efforts[0]!;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
