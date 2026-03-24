import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadPersistedState, savePersistedState } from './persistence';
import { PtySessionManager } from './pty-session-manager';
import { sanitizePersistedState, type PersistedAppState, type TerminalLaunchRequest, type WindowStateSnapshot } from '../src/types/app';
import type { AppUpdateState } from '../src/types/electron-api';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtySessionManager | null = null;
let persistedStateCache: PersistedAppState | null = null;
let persistedStateWarnings: string[] = [];
let ipcRegistered = false;
let updaterConfigured = false;
const execFileAsync = promisify(execFile);
let appUpdateState: AppUpdateState = {
  phase: 'unsupported',
  currentVersion: app.getVersion(),
};

async function bootstrap(): Promise<void> {
  const loadResult = await loadPersistedState();
  persistedStateCache = loadResult.state;
  persistedStateWarnings = loadResult.warnings;

  mainWindow = createMainWindow(loadResult.state.settings.windowState);
  ptyManager = new PtySessionManager(() => mainWindow);

  registerIpcHandlers();
  configureAutoUpdater();

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createMainWindow(windowState: WindowStateSnapshot): BrowserWindow {
  const window = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#090d13',
    autoHideMenuBar: true,
    icon: resolveWindowIconPath(),
    title: 'Lookout',
    frame: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (windowState.isMaximized) {
    window.maximize();
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void loadRendererWithRetry(window, devServerUrl);
  } else {
    void window.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  window.on('closed', () => {
    mainWindow = null;
  });

  window.webContents.on('did-finish-load', () => {
    emitAppUpdateState();
  });

  return window;
}

function resolveWindowIconPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'app-icon.ico') : path.join(app.getAppPath(), 'public', 'app-icon.ico');
}

async function loadRendererWithRetry(window: BrowserWindow, url: string): Promise<void> {
  const maxAttempts = 15;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      await delay(250);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function registerIpcHandlers(): void {
  if (ipcRegistered) {
    return;
  }

  ipcRegistered = true;

  ipcMain.handle('lookout:load-state', async () => ({
    state: persistedStateCache ?? sanitizePersistedState(null),
    warnings: persistedStateWarnings,
  }));

  ipcMain.handle('lookout:save-state', async (_event, state: PersistedAppState) => {
    const sanitized = sanitizePersistedState(state);
    const mergedState = {
      ...sanitized,
      settings: {
        ...sanitized.settings,
        windowState: captureWindowState(mainWindow),
      },
    };

    persistedStateCache = mergedState;
    await savePersistedState(mergedState);
  });

  ipcMain.handle('lookout:get-app-update-state', async () => appUpdateState);

  ipcMain.handle('lookout:check-for-app-updates', async () => {
    if (!app.isPackaged) {
      updateAppUpdateState({
        phase: 'unsupported',
        currentVersion: app.getVersion(),
        error: 'App updates are only available in packaged builds.',
      });
      return appUpdateState;
    }

    await autoUpdater.checkForUpdates();
    return appUpdateState;
  });

  ipcMain.handle('lookout:download-app-update', async () => {
    if (!app.isPackaged) {
      updateAppUpdateState({
        phase: 'unsupported',
        currentVersion: app.getVersion(),
        error: 'App updates are only available in packaged builds.',
      });
      return appUpdateState;
    }

    await autoUpdater.downloadUpdate();
    return appUpdateState;
  });

  ipcMain.handle('lookout:install-app-update', async () => {
    if (appUpdateState.phase !== 'downloaded') {
      return;
    }

    setImmediate(() => {
      autoUpdater.quitAndInstall();
    });
  });

  ipcMain.handle('lookout:list-local-fonts', async () => listLocalFonts());

  ipcMain.handle('lookout:pick-directory', async (_event, initialPath?: string) => {
    const options: OpenDialogOptions = {
      defaultPath: initialPath,
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select project space folder',
    };
    const response = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

    if (response.canceled) {
      return null;
    }

    return response.filePaths[0] ?? null;
  });

  ipcMain.handle('lookout:validate-directory', async (_event, inputPath: string) => {
    if (!inputPath.trim()) {
      return {
        valid: false,
        error: 'Folder path is required.',
      };
    }

    const normalizedPath = path.resolve(inputPath);

    try {
      await access(normalizedPath);
      return { valid: true, normalizedPath };
    } catch {
      return {
        valid: false,
        normalizedPath,
        error: 'Folder path does not exist or is not accessible.',
      };
    }
  });

  ipcMain.handle('lookout:open-path', async (_event, inputPath: string) => {
    await shell.openPath(inputPath);
  });

  ipcMain.handle('lookout:window-minimize', async () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('lookout:window-toggle-maximize', async () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return;
    }

    mainWindow.maximize();
  });

  ipcMain.handle('lookout:window-close', async () => {
    mainWindow?.close();
  });

  ipcMain.handle('lookout:start-terminal', async (_event, request: TerminalLaunchRequest) => {
    if (!ptyManager) {
      return {
        ok: false,
        error: 'Terminal backend is not ready.',
      };
    }

    return ptyManager.startSession(request);
  });

  ipcMain.handle('lookout:stop-terminal', async (_event, sessionId: string) => {
    ptyManager?.stopSession(sessionId);
  });

  ipcMain.handle('lookout:write-terminal', async (_event, payload: { sessionId: string; data: string }) => {
    ptyManager?.write(payload.sessionId, payload.data);
  });

  ipcMain.handle(
    'lookout:resize-terminal',
    async (_event, payload: { sessionId: string; cols: number; rows: number }) => {
      ptyManager?.resize(payload.sessionId, payload.cols, payload.rows);
    },
  );
}

function configureAutoUpdater(): void {
  if (updaterConfigured) {
    return;
  }

  updaterConfigured = true;

  if (!app.isPackaged) {
    updateAppUpdateState({
      phase: 'unsupported',
      currentVersion: app.getVersion(),
      error: 'App updates are only available in packaged builds.',
    });
    return;
  }

  updateAppUpdateState({
    phase: 'idle',
    currentVersion: app.getVersion(),
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateAppUpdateState({
      phase: 'checking',
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on('update-available', (info) => {
    updateAppUpdateState({
      phase: 'available',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    updateAppUpdateState({
      phase: 'not-available',
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      availableVersion: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      percent: undefined,
      bytesPerSecond: undefined,
      transferred: undefined,
      total: undefined,
      downloadedFile: undefined,
      error: undefined,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    updateAppUpdateState({
      ...appUpdateState,
      phase: 'downloading',
      currentVersion: app.getVersion(),
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      error: undefined,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateAppUpdateState({
      phase: 'downloaded',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      downloadedFile: info.downloadedFile,
      percent: 100,
      error: undefined,
    });
  });

  autoUpdater.on('error', (error) => {
    updateAppUpdateState({
      ...appUpdateState,
      phase: 'error',
      currentVersion: app.getVersion(),
      error: error?.message ?? String(error),
    });
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      updateAppUpdateState({
        ...appUpdateState,
        phase: 'error',
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 3000);
}

function updateAppUpdateState(nextState: AppUpdateState): void {
  appUpdateState = nextState;
  emitAppUpdateState();
}

function emitAppUpdateState(): void {
  mainWindow?.webContents.send('lookout:app-update-state', appUpdateState);
}

function captureWindowState(window: BrowserWindow | null): WindowStateSnapshot {
  if (!window) {
    return persistedStateCache?.settings.windowState ?? {
      width: 1600,
      height: 980,
    };
  }

  const bounds = window.getBounds();
  return {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: window.isMaximized(),
  };
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  ptyManager?.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  ptyManager?.dispose();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const state = persistedStateCache ?? sanitizePersistedState(null);
    mainWindow = createMainWindow(state.settings.windowState);
    if (!ptyManager) {
      ptyManager = new PtySessionManager(() => mainWindow);
      registerIpcHandlers();
    }
  }
});

async function listLocalFonts(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const fontEntries = await Promise.all([
    queryWindowsFontRegistry('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
    queryWindowsFontRegistry('HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
  ]);

  return [...new Set(fontEntries.flat())].sort((left, right) => left.localeCompare(right));
}

async function queryWindowsFontRegistry(registryPath: string): Promise<string[]> {
  const regExecutable = resolveRegExecutable();

  try {
    const { stdout } = await execFileAsync(regExecutable, ['query', registryPath], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map(parseFontFamilyFromRegistryLine)
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

function resolveRegExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'reg.exe');
}

function parseFontFamilyFromRegistryLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('REG_')) {
    return null;
  }

  const nameMatch = trimmed.match(/^(.+?)\s+REG_\w+\s+/);
  if (!nameMatch?.[1]) {
    return null;
  }

  return nameMatch[1]
    .replace(/\s+\((TrueType|OpenType)\)$/i, '')
    .replace(/\s*&\s+/g, ' & ')
    .trim();
}

function normalizeReleaseNotes(releaseNotes: string | Array<{ note?: string | null }> | null | undefined): string | undefined {
  if (!releaseNotes) {
    return undefined;
  }

  if (typeof releaseNotes === 'string') {
    return releaseNotes;
  }

  const notes = releaseNotes
    .map((entry) => entry.note?.trim())
    .filter((entry): entry is string => Boolean(entry));

  return notes.length ? notes.join('\n\n') : undefined;
}
