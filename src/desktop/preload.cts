// Sandboxed Electron preload scripts use CommonJS and expose only this bounded bridge.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('orchestrationDesktop', {
  getAccountUsage: (refresh: boolean) => ipcRenderer.invoke('desktop:get-account-usage', refresh),
  importClaudeUsage: (text: string) => ipcRenderer.invoke('desktop:import-claude-usage', text),
  completeOnboarding: () => ipcRenderer.invoke('desktop:complete-onboarding'),
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  getModelCatalog: () => ipcRenderer.invoke('desktop:get-model-catalog'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('desktop:save-settings', settings),
  chooseExecutable: (provider: 'claude' | 'codex') =>
    ipcRenderer.invoke('desktop:choose-executable', provider),
  chooseProjectDirectory: () => ipcRenderer.invoke('desktop:choose-project-directory'),
  getAppInfo: () => ipcRenderer.invoke('desktop:get-app-info'),
});
