import type { ModelCatalog, ModelEffort } from '../shared/model-catalog.js';

export type DesktopAdapterMode = 'fake' | 'cli';
export type ClaudeEffort = '' | ModelEffort;
export type CodexEffort = '' | ModelEffort;

export type { DesktopSettings } from '../desktop/settings.js';
import type { DesktopSettings } from '../desktop/settings.js';

export interface DesktopBridge {
  getSettings: () => Promise<DesktopSettings>;
  getModelCatalog: () => Promise<ModelCatalog>;
  saveSettings: (settings: DesktopSettings) => Promise<DesktopSettings>;
  chooseExecutable: (provider: 'claude' | 'codex') => Promise<string | null>;
  chooseProjectDirectory: () => Promise<string | null>;
  getAppInfo: () => Promise<{ version: string; packaged: boolean }>;
}

declare global {
  interface Window {
    orchestrationDesktop?: DesktopBridge;
  }
}

export const desktopBridge = window.orchestrationDesktop;
