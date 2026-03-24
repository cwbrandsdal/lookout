import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadPersistedState, savePersistedState } from './persistence';
import { PtySessionManager } from './pty-session-manager';
import { sanitizePersistedState, type PersistedAppState, type TerminalLaunchRequest, type WindowStateSnapshot } from '../src/types/app';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtySessionManager | null = null;
let persistedStateCache: PersistedAppState | null = null;
let persistedStateWarnings: string[] = [];
let ipcRegistered = false;
const execFileAsync = promisify(execFile);

async function bootstrap(): Promise<void> {
  const loadResult = await loadPersistedState();
  persistedStateCache = loadResult.state;
  persistedStateWarnings = loadResult.warnings;

  mainWindow = createMainWindow(loadResult.state.settings.windowState);
  ptyManager = new PtySessionManager(() => mainWindow);

  registerIpcHandlers();

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
