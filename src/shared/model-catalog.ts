export const MODEL_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export interface ModelSpec {
  id: string;
  label: string;
  efforts: ModelEffort[];
  defaultEffort: ModelEffort | null;
  recommendedEffort: ModelEffort;
}

export interface ModelCatalog {
  claude: ModelSpec[];
  codex: ModelSpec[];
}

export const CLAUDE_MODEL_CATALOG: ModelSpec[] = [
  {
    id: 'opus',
    label: 'Opus (최신 별칭)',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    recommendedEffort: 'xhigh',
  },
  {
    id: 'sonnet',
    label: 'Sonnet (최신 별칭)',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    recommendedEffort: 'high',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    recommendedEffort: 'xhigh',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    recommendedEffort: 'high',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    recommendedEffort: 'high',
  },
];

/** Used only when the installed Codex CLI cache is absent or malformed. */
export const FALLBACK_CODEX_MODEL_CATALOG: ModelSpec[] = [
  codexModel('gpt-6-astra', 'GPT-6 Astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-sol', 'GPT-5.6 Sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-terra', 'GPT-5.6 Terra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-luna', 'GPT-5.6 Luna', ['low', 'medium', 'high', 'xhigh', 'max']),
  codexModel('gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high', 'xhigh']),
];

export const DEFAULT_MODEL_CATALOG: ModelCatalog = {
  claude: CLAUDE_MODEL_CATALOG,
  codex: FALLBACK_CODEX_MODEL_CATALOG,
};

function codexModel(id: string, label: string, efforts: ModelEffort[]): ModelSpec {
  return {
    id,
    label,
    efforts,
    defaultEffort: 'medium',
    recommendedEffort: efforts.includes('medium') ? 'medium' : efforts[0]!,
  };
}

export function isModelEffort(value: unknown): value is ModelEffort {
  return MODEL_EFFORTS.includes(value as ModelEffort);
}

export function compatibleSelection(
  provider: keyof ModelCatalog,
  model: string,
  effort: unknown,
  catalog: ModelCatalog,
): { model: string; effort: ModelEffort | '' } {
  const spec = catalog[provider].find((candidate) => candidate.id === model);
  if (!spec) return { model: '', effort: '' };
  return {
    model: spec.id,
    effort: isModelEffort(effort) && spec.efforts.includes(effort) ? effort : '',
  };
}
