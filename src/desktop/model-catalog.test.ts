import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadDesktopModelCatalog } from './model-catalog.js';

describe('desktop model catalog', () => {
  it('reads only visible Codex models and their exact supported efforts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-model-catalog-'));
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'models_cache.json'),
        JSON.stringify({
          models: [
            {
              slug: 'visible-model',
              display_name: 'Visible Model',
              visibility: 'list',
              default_reasoning_level: 'low',
              supported_reasoning_levels: [
                { effort: 'low' },
                { effort: 'high' },
                { effort: 'not-real' },
              ],
            },
            {
              slug: 'hidden-model',
              display_name: 'Hidden Model',
              visibility: 'hide',
              supported_reasoning_levels: [{ effort: 'max' }],
            },
          ],
        }),
      );

      const catalog = loadDesktopModelCatalog({ CODEX_HOME: directory });
      expect(catalog.codex).toEqual([
        {
          id: 'visible-model',
          label: 'Visible Model',
          efforts: ['low', 'high'],
          defaultEffort: 'low',
          recommendedEffort: 'low',
        },
      ]);
      expect(catalog.claude.find((model) => model.id === 'sonnet')?.efforts).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to the bundled Codex catalog when the cache is unavailable', () => {
    const catalog = loadDesktopModelCatalog({ CODEX_HOME: join(tmpdir(), 'missing-codex-home') });
    expect(catalog.codex.map((model) => model.id)).toContain('gpt-5.6-sol');
  });
});
