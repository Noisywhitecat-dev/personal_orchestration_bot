import { describe, expect, it } from 'vitest';
import { diagnosticSummary } from './diagnostics.js';
import type { RuntimeStatusResponse, TaskDetailResponse } from './contracts.js';
import { PRESETS, presetModels, presetLimits } from './presets.js';
import { DEFAULT_MODEL_CATALOG } from './model-catalog.js';

describe('diagnostic export', () => {
  it('never exports identifiers, secrets, names, paths, arbitrary errors, prompts, diff or output', () => {
    const secret = 'PRIVATE_SENTINEL_api-key_session-id_prompt_diff_stdout';
    const detail = {
      task: {
        id: secret,
        request: secret,
        plan: { summary: secret },
        state: 'failed',
        failure: { code: secret, message: secret },
        reviewRound: 1,
      },
      runs: [
        {
          id: secret,
          sessionId: secret,
          provider: 'claude',
          kind: 'plan',
          status: 'failed',
          error: { message: secret },
        },
      ],
      timeline: [{ payload: { text: secret, command: secret, stdoutTail: secret } }],
      usage: { claude: { totalTokens: 5 }, codex: { totalTokens: null } },
      budget: { secret },
    } as unknown as TaskDetailResponse;
    const runtime = {
      claude: { adapter: 'cli', executable: secret, model: secret },
      codex: { adapter: 'fake' },
      database: secret,
    } as unknown as RuntimeStatusResponse;
    const json = JSON.stringify(diagnosticSummary(runtime, detail));
    expect(json).not.toContain(secret);
    expect(json).not.toMatch(/sessionId|request|stdout|database|timeline|failure/);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 1,
      tokens: { claude: 5, codex: null },
      state: 'failed',
    });
  });
  it('whitelists enum strings even when poisoned public objects are supplied', () => {
    const detail = {
      task: { state: 'SECRET', reviewRound: 'SECRET' },
      runs: [{ kind: 'SECRET', status: 'SECRET' }],
      usage: { claude: { totalTokens: 'SECRET' }, codex: { totalTokens: -1 } },
    } as unknown as TaskDetailResponse;
    expect(JSON.stringify(diagnosticSummary(null, detail))).not.toContain('SECRET');
    expect(diagnosticSummary(null, null).runs).toEqual([]);
  });
});

describe('safe presets', () => {
  it('only returns compatible effort and bounded limits; no adapter or execution mutation', () => {
    for (const key of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      const models = presetModels(key, DEFAULT_MODEL_CATALOG);
      const limits = presetLimits(key);
      for (const provider of ['claude', 'codex'] as const) {
        const model = models[`${provider}Model`];
        const effort = models[`${provider}Effort`];
        if (model)
          expect(DEFAULT_MODEL_CATALOG[provider].find((m) => m.id === model)?.efforts).toContain(
            effort,
          );
        else expect(effort).toBe('');
      }
      expect(limits.maxClaudeRuns).toBeGreaterThan(limits.maxReviewRounds);
      expect(models).not.toHaveProperty('claudeAdapter');
    }
  });
});
