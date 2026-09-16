export type DesktopAdapterMode = 'fake' | 'cli';

export interface DesktopSettings {
  claudeAdapter: DesktopAdapterMode;
  codexAdapter: DesktopAdapterMode;
  claudeExecutable: string;
  codexExecutable: string;
}

export interface DesktopBridge {
  getSettings: () => Promise<DesktopSettings>;
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
