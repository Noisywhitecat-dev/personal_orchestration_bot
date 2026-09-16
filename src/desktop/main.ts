import { AccountUsageStore } from './account-usage.js';
import { readCodexAccountUsage } from './codex-account-usage.js';
import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from 'electron';

import { startApplicationServer, type RunningApplicationServer } from '../server/bootstrap.js';
import type { ModelCatalog } from '../shared/model-catalog.js';
import { loadDesktopModelCatalog } from './model-catalog.js';
import {
  DEFAULT_DESKTOP_SETTINGS,
  desktopEnvironment,
  loadDesktopSettings,
  saveDesktopSettings,
  type DesktopSettings,
} from './settings.js';

console.log(`[desktop] starting Electron ${process.versions.electron ?? 'unknown'}`);

const accountUsage = new AccountUsageStore();
let runtime: RunningApplicationServer | null = null;
let mainWindow: BrowserWindow | null = null;
let currentSettings: DesktopSettings;
let settingsPath: string;
let quitting = false;
let applyingSettings = false;
let allowedOrigin: string | null = null;
let modelCatalog: ModelCatalog;

function appRoot(): string {
  return app.getAppPath();
}

async function closeRuntime(): Promise<void> {
  const active = runtime;
  runtime = null;
  if (active) await active.close();
}

async function applySavedSettings(previousSettings: DesktopSettings): Promise<void> {
  if (quitting || applyingSettings) return;
  applyingSettings = true;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      allowedOrigin = 'null';
      const applyingPage = encodeURIComponent(
        '<!doctype html><html lang="ko"><meta charset="utf-8"><title>설정 적용 중</title><body style="background:#10131a;color:#eef2ff;font-family:sans-serif;padding:32px"><h2>설정을 적용하고 있습니다…</h2><p>잠시만 기다려 주세요.</p></body></html>',
      );
      await mainWindow.loadURL(`data:text/html;charset=utf-8,${applyingPage}`);
    }
    await closeRuntime();
    accountUsage.clear();
    try {
      runtime = await startEmbeddedServer(currentSettings);
    } catch (error) {
      currentSettings = saveDesktopSettings(settingsPath, previousSettings, modelCatalog);
      await dialog.showMessageBox({
        type: 'warning',
        title: '설정을 적용할 수 없습니다',
        message: '새 설정으로 서버를 시작하지 못해 이전 설정으로 되돌렸습니다.',
        detail: error instanceof Error ? error.message : String(error),
        buttons: ['확인'],
        noLink: true,
      });
      runtime = await startEmbeddedServer(currentSettings);
    }

    allowedOrigin = new URL(runtime.url).origin;
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(runtime.url);
  } catch (error) {
    dialog.showErrorBox(
      '설정 적용 실패',
      `${error instanceof Error ? error.message : String(error)}\n\n앱을 수동으로 다시 시작해 주세요.`,
    );
  } finally {
    applyingSettings = false;
  }
}

function registerIpc(): void {
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== allowedOrigin)
      throw new Error('허용되지 않은 화면입니다.');
  };
  ipcMain.handle('desktop:get-account-usage', (event, refresh: unknown) => {
    trusted(event);
    return refresh === true
      ? accountUsage.refresh(() =>
          readCodexAccountUsage(currentSettings.codexExecutable, app.getPath('userData')),
        )
      : accountUsage.snapshot();
  });
  ipcMain.handle('desktop:import-claude-usage', (event, text: unknown) => {
    trusted(event);
    return accountUsage.importStatus(text);
  });
  ipcMain.handle('desktop:complete-onboarding', (event) => {
    trusted(event);
    currentSettings = saveDesktopSettings(
      settingsPath,
      { ...currentSettings, onboardingCompleted: true },
      modelCatalog,
    );
  });
  ipcMain.handle('desktop:get-settings', () => currentSettings);
  ipcMain.handle('desktop:get-model-catalog', () => modelCatalog);
  ipcMain.handle('desktop:get-app-info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));
  ipcMain.handle('desktop:choose-executable', async (_event, provider: unknown) => {
    if (provider !== 'claude' && provider !== 'codex') return null;
    const result = await showOpenDialog({
      title: provider === 'claude' ? 'Claude Code 실행 파일 선택' : 'Codex 실행 파일 선택',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '실행 파일', extensions: ['exe'] }] : [],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('desktop:choose-project-directory', async () => {
    const result = await showOpenDialog({
      title: '작업할 프로젝트 폴더 선택',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('desktop:save-settings', (_event, value: unknown) => {
    const previousSettings = currentSettings;
    currentSettings = saveDesktopSettings(settingsPath, value, modelCatalog);
    setTimeout(() => void applySavedSettings(previousSettings), 300);
    return currentSettings;
  });
}

function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

function installKoreanMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [{ label: '종료', role: 'quit', accelerator: 'Alt+F4' }],
    },
    {
      label: '보기',
      submenu: [
        { label: '새로 고침', role: 'reload', accelerator: 'F5' },
        { label: '강제로 새로 고침', role: 'forceReload', accelerator: 'Ctrl+Shift+R' },
        { label: '개발자 도구', role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
        { type: 'separator' },
        { label: '원래 크기', role: 'resetZoom', accelerator: 'Ctrl+0' },
        { label: '확대', role: 'zoomIn', accelerator: 'Ctrl+=' },
        { label: '축소', role: 'zoomOut', accelerator: 'Ctrl+-' },
        { type: 'separator' },
        { label: '전체 화면', role: 'togglefullscreen', accelerator: 'F11' },
      ],
    },
    {
      label: '창',
      submenu: [
        { label: '최소화', role: 'minimize' },
        { label: '창 닫기', role: 'close' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        {
          label: '앱 정보',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'AI orchestrator 정보',
              message: 'AI orchestrator',
              detail: `버전 ${app.getVersion()}\nClaude는 계획과 리뷰를, Codex는 코드 작성을 담당합니다.`,
              buttons: ['확인'],
              noLink: true,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<void> {
  try {
    runtime = await startEmbeddedServer(currentSettings);
  } catch (error) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'AI 실행 설정을 확인해 주세요',
      message: '저장된 Claude 또는 Codex 설정으로 앱을 시작할 수 없습니다.',
      detail: `${error instanceof Error ? error.message : String(error)}\n\n체험 모드로 되돌리면 앱 설정에서 실행 파일을 다시 선택할 수 있습니다.`,
      buttons: ['체험 모드로 시작', '종료'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) throw error;
    currentSettings = saveDesktopSettings(
      settingsPath,
      {
        ...currentSettings,
        claudeAdapter: DEFAULT_DESKTOP_SETTINGS.claudeAdapter,
        codexAdapter: DEFAULT_DESKTOP_SETTINGS.codexAdapter,
      },
      modelCatalog,
    );
    runtime = await startEmbeddedServer(currentSettings);
  }

  allowedOrigin = new URL(runtime.url).origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 520,
    minHeight: 520,
    show: false,
    title: 'AI orchestrator',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(appRoot(), 'dist', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin === null || new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  await window.loadURL(runtime.url);
}

function startEmbeddedServer(settings: DesktopSettings): Promise<RunningApplicationServer> {
  return startApplicationServer({
    host: '127.0.0.1',
    port: 0,
    databasePath: join(app.getPath('userData'), 'orchestration.db'),
    staticDir: join(appRoot(), 'dist', 'web'),
    env: desktopEnvironment(settings),
    modelCatalog,
    onClaudeQuota: (windows) => accountUsage.observe(windows),
    log: (line) => console.log(line),
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !runtime) return;
    event.preventDefault();
    quitting = true;
    void closeRuntime().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    console.log('[desktop] ready');
    settingsPath = join(app.getPath('userData'), 'settings.json');
    modelCatalog = loadDesktopModelCatalog();
    currentSettings = loadDesktopSettings(settingsPath, modelCatalog);
    registerIpc();
    installKoreanMenu();

    try {
      await createMainWindow();
    } catch (error) {
      dialog.showErrorBox(
        'AI orchestrator 시작 실패',
        error instanceof Error ? error.message : String(error),
      );
      await closeRuntime();
      app.exit(1);
    }
  });
}
