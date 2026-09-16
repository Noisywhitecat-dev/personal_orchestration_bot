import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DESKTOP_SETTINGS } from './settings.js';

const host = vi.hoisted(() => ({
  directory: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  events: new Map<string, (...args: unknown[]) => unknown>(),
  urls: [] as string[],
  windows: 0,
  quit: false,
}));
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => host.directory,
    getVersion: () => 'test',
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (name: string, fn: (...args: unknown[]) => unknown) => host.events.set(name, fn),
    quit: () => {
      host.quit = true;
    },
    exit: () => {
      throw new Error('Unexpected desktop startup failure');
    },
  },
  BrowserWindow: class {
    constructor() {
      host.windows++;
    }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    once = vi.fn();
    on = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    isDestroyed = () => false;
    loadURL = async (url: string) => {
      host.urls.push(url);
    };
  },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => host.handlers.set(name, fn),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('./model-catalog.js', async () => {
  const { DEFAULT_MODEL_CATALOG } = await import('../shared/model-catalog.js');
  return { loadDesktopModelCatalog: () => DEFAULT_MODEL_CATALOG };
});

describe('desktop production lifecycle with a fake Electron window', () => {
  it('saves normalized settings, restarts the real embedded fake server and reloads the same window without AI', async () => {
    host.directory = mkdtempSync(join(tmpdir(), 'orch-desktop-lifecycle-'));
    try {
      await import('./main.js');
      await vi.waitFor(() => expect(host.urls.some((url) => url.startsWith('http:'))).toBe(true));
      const before = host.urls.at(-1)!;
      const oldStatus = (await (await fetch(before + '/api/runtime-status')).json()) as {
        claude: { adapter: string };
      };
      expect(oldStatus.claude.adapter).toBe('fake');
      host.handlers.get('desktop:save-settings')!(null, {
        ...DEFAULT_DESKTOP_SETTINGS,
        claudeModel: 'sonnet',
        claudeEffort: 'xhigh',
        codexModel: 'gpt-5.5',
        codexEffort: 'high',
        onboardingCompleted: true,
        executionLimits: { ...DEFAULT_DESKTOP_SETTINGS.executionLimits, maxClaudeRuns: 4 },
      });
      await vi.waitFor(
        () => expect(host.urls.filter((url) => url.startsWith('http:'))).toHaveLength(2),
        { timeout: 5000 },
      );
      const after = host.urls.at(-1)!;
      expect(after).not.toBe(before);
      expect(host.windows).toBe(1);
      const saved = JSON.parse(
        readFileSync(join(host.directory, 'settings.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(saved).toMatchObject({
        claudeEffort: '',
        codexEffort: 'high',
        onboardingCompleted: true,
      });
      const status = (await (await fetch(after + '/api/runtime-status')).json()) as {
        defaultExecutionLimits: { maxClaudeRuns: number };
      };
      expect(status.defaultExecutionLimits.maxClaudeRuns).toBe(4);
      const projects = await (await fetch(after + '/api/projects')).json();
      expect(projects).toEqual({ projects: [] });
      await expect(fetch(before + '/api/runtime-status')).rejects.toThrow();
    } finally {
      host.events.get('before-quit')?.({ preventDefault: () => undefined });
      await vi.waitFor(() => expect(host.quit).toBe(true));
      rmSync(host.directory, { recursive: true, force: true });
    }
  });
});
