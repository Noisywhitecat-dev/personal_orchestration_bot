import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DESKTOP_SETTINGS,
  desktopEnvironment,
  loadDesktopSettings,
  parseDesktopSettings,
  saveDesktopSettings,
} from './settings.js';

describe('desktop settings', () => {
  it('uses safe fake defaults for missing or invalid values', () => {
    expect(parseDesktopSettings(null)).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(
      parseDesktopSettings({
        claudeAdapter: 'unknown',
        codexAdapter: 1,
        claudeExecutable: '',
        codexExecutable: '   ',
      }),
    ).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it('accepts CLI modes and trimmed executable paths', () => {
    expect(
      parseDesktopSettings({
        claudeAdapter: 'cli',
        codexAdapter: 'cli',
        claudeExecutable: ' C:/tools/claude.exe ',
        codexExecutable: 'codex',
        claudeModel: ' sonnet ',
        claudeEffort: 'high',
        codexModel: ' gpt-5.6-sol ',
        codexEffort: 'medium',
      }),
    ).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      claudeAdapter: 'cli',
      codexAdapter: 'cli',
      claudeExecutable: 'C:/tools/claude.exe',
      codexExecutable: 'codex',
      claudeModel: 'sonnet',
      claudeEffort: 'high',
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'medium',
    });
  });

  it('adds only the desktop adapter values to a copied environment', () => {
    const base = { KEEP: 'yes' };
    const env = desktopEnvironment(DEFAULT_DESKTOP_SETTINGS, base);
    expect(env).toMatchObject({
      KEEP: 'yes',
      CLAUDE_ADAPTER: 'fake',
      CODEX_ADAPTER: 'fake',
      CLAUDE_EXECUTABLE: 'claude',
      CODEX_EXECUTABLE: 'codex',
    });
    expect(base).toEqual({ KEEP: 'yes' });
  });

  it('round-trips the per-user JSON settings through an atomic save', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-desktop-settings-'));
    try {
      const path = join(directory, 'settings.json');
      const saved = saveDesktopSettings(path, {
        claudeAdapter: 'cli',
        codexAdapter: 'fake',
        claudeExecutable: 'C:/claude.exe',
        codexExecutable: 'codex',
        claudeModel: 'opus',
        claudeEffort: 'medium',
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'high',
      });
      expect(loadDesktopSettings(path)).toEqual(saved);
      expect(readFileSync(path, 'utf8')).not.toContain('token');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes explicitly selected model and effort values without mutating the base environment', () => {
    const settings = parseDesktopSettings({
      ...DEFAULT_DESKTOP_SETTINGS,
      claudeModel: 'sonnet',
      claudeEffort: 'high',
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'medium',
    });
    expect(desktopEnvironment(settings, {})).toMatchObject({
      CLAUDE_MODEL: 'sonnet',
      CLAUDE_EFFORT: 'high',
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_REASONING_EFFORT: 'medium',
    });
  });

  it('removes unknown models and model-incompatible effort values', () => {
    expect(
      parseDesktopSettings({
        ...DEFAULT_DESKTOP_SETTINGS,
        claudeModel: 'unknown-claude',
        claudeEffort: 'high',
        codexModel: 'gpt-5.5',
        codexEffort: 'max',
      }),
    ).toMatchObject({
      claudeModel: '',
      claudeEffort: '',
      codexModel: 'gpt-5.5',
      codexEffort: '',
    });
  });
});
