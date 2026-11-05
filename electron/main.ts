import { app, globalShortcut, ipcMain, Menu, nativeTheme, Notification, shell, Tray, webContents as allWebContents } from 'electron';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CliAction, CliRequest } from './cli';
import { adminLaunchArgs, parseCliArgs, stripElectronArgs } from './cli';
import {
  INSTANCE_MARKER_FILE,
  isInstanceMarkerLive,
  isProcessElevated,
  launchElevated,
  removeInstanceMarker,
  writeInstanceMarker,
} from './elevation';
import { listLocalFonts } from './fonts';
import { runFirstRun } from './first-run';
import { GitService } from './git-service';
import { disableCliPath, enableCliPath, getCliPathStatus } from './integrations/cli-path';
import { disableDefaultTerminal, enableDefaultTerminal, getDefaultTerminalStatus, HANDOFF_PIPE_NAME } from './integrations/default-terminal';
import { disableExplorerMenu, enableExplorerMenu, getExplorerMenuStatus } from './integrations/explorer-menu';
import { paths } from './paths';
import { detectProfiles, mergeDetectedProfiles } from './profiles/detect';
import { importWindowsTerminal } from './profiles/windows-terminal';
import { PtyHostClient } from './pty-host-client';
import { SettingsStore } from './settings-store';
import { readWorkspaces, StateStore } from './state-store';
import { createUpdater } from './updater';
import { WindowManager, type ManagedWindow } from './window-manager';
import { sanitizeSettings } from '../src/shared/settings-defaults';
import type {
  AppUpdateState,
  BootstrapPayload,
  IntegrationId,
  IntegrationStatus,
  NotificationRequest,
  PathProbe,
  TaskbarProgress,
  WindowAction,
} from '../src/shared/ipc';
import type { LookoutSettings } from '../src/shared/settings';
import { paneLeaf, splitPane as splitLayoutPane } from '../src/shared/layout';
import { newId, type LayoutNode, type PaneSpec, type TabSpec, type WindowSpec, type WorkspaceTemplate } from '../src/shared/session';

// ---------------------------------------------------------------------------
// Process identity: an elevated instance has its own windows, session and lock,
// but shares settings (profiles, theme, keys) with the normal instance and copies
// its administrator workspaces.
// ---------------------------------------------------------------------------

/** Automated UI tests: isolated data, no tray/hotkeys/handoff/updates. */
const testMode = process.env.LOOKOUT_TEST === '1';
/** Tests can stand in for the administrator instance without a UAC prompt. */
const elevated = (testMode && process.env.LOOKOUT_TEST_ELEVATED === '1') || isProcessElevated();
const defaultUserData = app.getPath('userData');
const adminDataDir = path.join(app.getPath('appData'), 'Lookout-Admin');
if (process.env.LOOKOUT_USER_DATA_DIR) {
  app.setPath('userData', process.env.LOOKOUT_USER_DATA_DIR);
} else if (elevated) {
  app.setPath('userData', adminDataDir);
}
/** The normal instance's data folder: settings.json, and the workspaces the admin window copies. */
const userInstanceDir = !elevated
  ? app.getPath('userData')
  : testMode
    ? (process.env.LOOKOUT_TEST_USER_INSTANCE_DIR ?? app.getPath('userData'))
    : defaultUserData;
app.setAppUserModelId(elevated ? 'no.cwb.lookout.admin' : 'no.cwb.lookout');

const launchArgs = stripElectronArgs(process.argv, { isPackaged: app.isPackaged });
const gotLock = app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() });
if (!gotLock || (process.argv.includes('--quit') && gotLock)) {
  // Second instance (args were forwarded), or `--quit` with nothing running.
  app.exit(0);
}

Menu.setApplicationMenu(null);

const windowsBuild = Number(os.release().split('.')[2] ?? 0) || 0;

let settingsStore: SettingsStore;
let stateStore: StateStore;
let host: PtyHostClient;
let windows: WindowManager;
let gitService: GitService;
let updater: ReturnType<typeof createUpdater>;
let tray: Tray | null = null;
let quitting = false;
let quitReady = false;
let notices: string[] = [];
let lastSettingsWarnings: string[] = [];
const activeNotifications = new Set<Notification>();
const gitSubscriptions = new Map<string, () => void>();

function settings(): LookoutSettings {
  return settingsStore.get();
}

function integrationContext() {
  return {
    exePath: process.execPath,
    appPath: app.isPackaged ? undefined : app.getAppPath(),
    userDataDir: app.getPath('userData'),
    nativeDir: paths.nativeDir,
    isPackaged: app.isPackaged,
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath('userData');
  stateStore = await StateStore.open(userDataDir);
  settingsStore = await SettingsStore.open({
    userDataDir: userInstanceDir,
    firstRun: async () => {
      const result = await runFirstRun({ v1: stateStore.getV1Migration() });
      notices = result.summary;
      importWtLayouts(result.wtLayouts ?? []);
      return result.settings;
    },
  });
  lastSettingsWarnings = sanitizeSettings(settingsStore.get()).warnings;

  host = new PtyHostClient({
    type: 'init',
    shellIntegrationDir: paths.shellIntegrationDir,
    handoffPipeName: elevated || (testMode && process.env.LOOKOUT_TEST_HANDOFF !== '1') ? null : HANDOFF_PIPE_NAME,
    windowsBuild,
    scrollback: settings().terminal.scrollback,
  });
  host.onHandoff = (session) => {
    const target = windows.lastFocusedNormal() ?? openWindow({});
    windows.dispatch(target, { type: 'adopt-session', session });
    windows.reveal(target);
  };

  gitService = new GitService();
  if (elevated) {
    writeInstanceMarker(path.join(userDataDir, INSTANCE_MARKER_FILE));
  }
  const adminMarker = path.join(adminDataDir, INSTANCE_MARKER_FILE);
  updater = createUpdater({
    isPackaged: app.isPackaged && !testMode,
    disabledReason: elevated ? 'Updates install from the normal Lookout window.' : undefined,
    installBlocker: () => (isInstanceMarkerLive(adminMarker) ? 'Close the administrator window first, then restart to update.' : undefined),
    onState: (state) => broadcast('lookout:update-state', state),
  });

  windows = new WindowManager({
    getSettings: settings,
    isQuitting: () => quitting,
    onWindowReady: () => {},
    onSpecChanged: (managed) => {
      if (!quitting) {
        stateStore.setWindow(managed.spec);
      }
    },
    onWindowClosed: (managed, last) => void handleWindowClosed(managed, last),
  });

  registerIpc();
  settingsStore.onChange((change) => applySettings(change.settings, false, change.warnings));
  settingsStore.onError((error) => {
    const message = error.kind === 'parse' ? `settings.json has a syntax error; keeping the last good settings. ${error.message}` : error.message;
    broadcast('lookout:settings', settings(), [message, ...(error.details ?? [])]);
  });
  nativeTheme.on('updated', () => windows.applyTheme(settings()));
  applySettings(settings(), true);

  if (!stateStore.get().firstRunComplete) {
    stateStore.setFirstRunComplete();
  } else if (!testMode) {
    // New WSL distros, SSH hosts or shells installed since last time show up on their own.
    setTimeout(() => {
      void detectProfiles()
        .then(async (detected) => {
          const current = settings().profiles;
          const merged = mergeDetectedProfiles(current, detected);
          if (JSON.stringify(merged) !== JSON.stringify(current)) {
            await settingsStore.update((draft) => {
              draft.profiles = merged;
            });
          }
        })
        .catch((error: unknown) => console.warn('[lookout] profile detection failed', error));
    }, 4000);
  }

  // Started at login: stay in the tray until summoned.
  if (process.argv.includes('--background') && settings().window.keepRunningInTray) {
    return;
  }

  const explicitArgs = launchArgs.filter((arg) => arg !== '--background' && arg !== '--elevated');
  const initialActions = explicitArgs.length ? cliToActions(parseCliArgs(explicitArgs, process.cwd())) : [];
  await importUserWorkspaces(initialActions);
  restoreWindows(initialActions);
}

/**
 * The administrator window copies the normal instance's administrator workspaces,
 * plus any workspace it is asked to open, so they open here and show in its sidebar.
 */
async function importUserWorkspaces(actions: WindowAction[]): Promise<void> {
  if (!elevated || path.resolve(userInstanceDir) === path.resolve(app.getPath('userData'))) {
    return;
  }
  const requested = new Set(actions.flatMap((action) => (action.type === 'open-workspace' ? [action.nameOrId.toLowerCase()] : [])));
  const wanted = (await readWorkspaces(userInstanceDir)).filter(
    (workspace) => workspace.elevate || requested.has(workspace.id.toLowerCase()) || requested.has(workspace.name.toLowerCase()),
  );
  if (stateStore.importWorkspaces(wanted)) {
    broadcast('lookout:workspaces', stateStore.get().workspaces);
  }
}

/** Windows Terminal's saved tabs become workspaces, so the old session is one click away. */
function importWtLayouts(layouts: NonNullable<Awaited<ReturnType<typeof runFirstRun>>['wtLayouts']>): void {
  const now = new Date().toISOString();
  layouts.forEach((wtTab, index) => {
    const first: PaneSpec = { id: newId(), profileId: wtTab.profileId ?? 'pwsh', cwd: wtTab.startingDirectory, commandline: wtTab.commandline };
    const panes: Record<string, PaneSpec> = { [first.id]: first };
    let layout: LayoutNode = paneLeaf(first.id);
    let anchor = first.id;
    for (const wtPane of wtTab.panes ?? []) {
      const pane: PaneSpec = { id: newId(), profileId: wtPane.profileId ?? first.profileId, cwd: wtPane.startingDirectory, commandline: wtPane.commandline };
      panes[pane.id] = pane;
      layout = splitLayoutPane(layout, anchor, pane.id, wtPane.split === 'down' ? 'down' : 'right');
      anchor = pane.id;
    }
    stateStore.upsertWorkspace({
      id: newId(),
      name: `Windows Terminal · ${wtTab.title ?? `tab ${index + 1}`}`,
      rootPath: wtTab.startingDirectory,
      layout,
      panes,
      createdAt: now,
      updatedAt: now,
    });
  });
  if (layouts.length) {
    notices.push(`Saved your last Windows Terminal session as ${layouts.length} workspace${layouts.length === 1 ? '' : 's'}.`);
  }
}

function restoreWindows(initialActions: WindowAction[]): void {
  const saved = stateStore.get().windows.filter((spec) => spec.kind === 'normal');
  const restore = settings().window.restoreSession ? saved : [];

  if (!restore.length) {
    openWindow({}, initialActions.length ? initialActions : [{ type: 'new-tab' }]);
    return;
  }

  restore.forEach((spec, index) => {
    const isLast = index === restore.length - 1;
    openWindow(spec, isLast ? initialActions : []);
  });
}

function openWindow(spec: Partial<WindowSpec>, actions: WindowAction[] = [], options: { at?: { x: number; y: number }; show?: boolean } = {}): ManagedWindow {
  const managed = windows.create({ ...spec, kind: spec.kind ?? 'normal' }, actions, options);
  stateStore.setWindow(managed.spec);
  return managed;
}

function openQuakeWindow(): ManagedWindow {
  const saved = stateStore.get().windows.find((spec) => spec.kind === 'quake');
  return openWindow(saved ?? { kind: 'quake' }, saved?.tabs.length ? [] : [{ type: 'new-tab' }]);
}

async function handleWindowClosed(managed: ManagedWindow, last: boolean): Promise<void> {
  for (const [key, unsubscribe] of gitSubscriptions) {
    if (key.startsWith(`${managed.id}|`)) {
      unsubscribe();
      gitSubscriptions.delete(key);
    }
  }

  if (quitting) {
    return;
  }

  if (last && settings().window.restoreSession) {
    // Keep the layout for the next time a window opens; save scrollback too.
    await persistBuffers([managed.id]);
    stateStore.setWindow(managed.spec);
  } else {
    managed.spec.tabs.forEach((tab) => stateStore.pushClosedTab(tab));
    stateStore.removeWindow(managed.id);
  }

  host.disconnectWindow(managed.id, true);
  await stateStore.flush();

  if (last && !settings().window.keepRunningInTray) {
    app.quit();
  }
}

async function persistBuffers(windowIds?: string[]): Promise<void> {
  if (!settings().window.restoreBuffers) {
    return;
  }

  const buffers = await host.serialize(Math.min(settings().terminal.scrollback, 5000));
  const knownPaneIds = new Set(
    stateStore
      .get()
      .windows.filter((spec) => !windowIds || windowIds.includes(spec.id))
      .flatMap((spec) => spec.tabs.flatMap((tab) => Object.keys(tab.panes))),
  );
  for (const managed of windows.all()) {
    if (!windowIds || windowIds.includes(managed.id)) {
      managed.spec.tabs.forEach((tab) => Object.keys(tab.panes).forEach((paneId) => knownPaneIds.add(paneId)));
    }
  }

  const entries = buffers
    .filter((buffer) => buffer.paneId && knownPaneIds.has(buffer.paneId) && (!windowIds || (buffer.ownerWindowId && windowIds.includes(buffer.ownerWindowId))))
    .map((buffer) => ({ paneId: buffer.paneId as string, data: buffer.data }));
  await stateStore.saveBuffers(entries);
}

// ---------------------------------------------------------------------------
// Settings side effects
// ---------------------------------------------------------------------------

function applySettings(next: LookoutSettings, initial = false, warnings: string[] = []): void {
  if (!initial) {
    lastSettingsWarnings = warnings;
    broadcast('lookout:settings', next, lastSettingsWarnings);
    host.setScrollback(next.terminal.scrollback);
  }

  windows.applyTheme(next);
  if (testMode) {
    return;
  }

  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.window.launchOnLogin, args: ['--background'] });
  }

  registerHotkeys(next);
  updateTray(next);
}

/**
 * Electron maps accelerator characters to US virtual-key codes. "`" means "the key
 * left of 1" on US layouts, but on Nordic/German layouts that physical key is
 * VK_OEM_5 (which Electron calls "\"). Translate so Win+` always hits that key.
 */
let backquoteKeyOnLayout = '`';
function layoutAccelerator(accelerator: string): string {
  if (!accelerator.includes('`') || backquoteKeyOnLayout === '`') {
    return accelerator;
  }
  return ['|', '§', '^', '<', '½'].includes(backquoteKeyOnLayout) ? accelerator.replace('`', '\\') : accelerator;
}

function registerHotkeys(next: LookoutSettings): void {
  globalShortcut.unregisterAll();
  const failures: string[] = [];

  if (next.quake.enabled && next.quake.hotkey) {
    const hotkey = layoutAccelerator(next.quake.hotkey);
    try {
      if (!globalShortcut.register(hotkey, () => windows.toggleQuake(openQuakeWindow))) {
        failures.push(hotkey);
      }
    } catch {
      failures.push(hotkey);
    }
  }

  if (next.window.summonHotkey) {
    try {
      if (!globalShortcut.register(layoutAccelerator(next.window.summonHotkey), toggleSummon)) {
        failures.push(next.window.summonHotkey);
      }
    } catch {
      failures.push(next.window.summonHotkey);
    }
  }

  if (failures.length) {
    console.warn(`[lookout] could not register global hotkeys: ${failures.join(', ')}`);
  }
}

function toggleSummon(): void {
  const managed = windows.lastFocusedNormal();
  if (!managed) {
    restoreWindows([]);
    return;
  }

  if (managed.win.isFocused() && managed.win.isVisible()) {
    managed.win.minimize();
    return;
  }

  windows.reveal(managed);
}

function showMain(): void {
  const managed = windows.lastFocusedNormal();
  if (managed) {
    windows.reveal(managed);
    return;
  }

  restoreWindows([]);
}

function updateTray(next: LookoutSettings): void {
  if (!next.window.keepRunningInTray) {
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    tray = new Tray(paths.trayIcon);
    tray.setToolTip(elevated ? 'Lookout (Administrator)' : 'Lookout');
    tray.on('click', showMain);
  }

  const profileItems = next.profiles
    .filter((profile) => !profile.hidden)
    .slice(0, 12)
    .map((profile) => ({
      label: profile.name,
      click: () => {
        const target = windows.lastFocusedNormal() ?? openWindow({});
        windows.dispatch(target, { type: 'new-tab', profileId: profile.id });
        windows.reveal(target);
      },
    }));

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Lookout', click: showMain },
      { label: 'New window', click: () => openWindow({}, [{ type: 'new-tab' }]) },
      { label: 'New tab', submenu: profileItems },
      { label: 'Drop-down terminal', click: () => windows.toggleQuake(openQuakeWindow) },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          const target = windows.lastFocusedNormal() ?? openWindow({});
          windows.dispatch(target, { type: 'open-settings' });
          windows.reveal(target);
        },
      },
      { type: 'separator' },
      { label: 'Quit Lookout', click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliToActions(request: CliRequest): WindowAction[] {
  return request.actions.flatMap((action: CliAction): WindowAction[] => {
    switch (action.type) {
      case 'new-tab':
        return [
          {
            type: 'new-tab',
            profileId: action.profile,
            cwd: action.startingDirectory,
            title: action.title,
            tabColor: action.tabColor,
            commandline: action.commandline,
          },
        ];
      case 'split-pane':
        return [
          {
            type: 'split-pane',
            direction: action.direction,
            size: action.size,
            profileId: action.profile,
            cwd: action.startingDirectory,
            title: action.title,
            commandline: action.commandline,
          },
        ];
      case 'focus-tab':
        return [{ type: 'focus-tab', index: action.index }];
      case 'open-workspace':
        return [{ type: 'open-workspace', nameOrId: action.name }];
      case 'settings':
        return [{ type: 'open-settings' }];
      default:
        return [];
    }
  });
}

async function handleSecondInstance(argv: string[], cwd: string): Promise<void> {
  if (!windows) {
    return;
  }

  const args = stripElectronArgs(argv, { isPackaged: app.isPackaged });
  // `Lookout.exe --quit`: graceful shutdown (saves tabs + scrollback), used by updates/scripts.
  if (args.includes('--quit')) {
    app.quit();
    return;
  }
  const request = parseCliArgs(args, cwd);

  if (request.actions.some((action) => action.type === 'quake')) {
    windows.toggleQuake(openQuakeWindow);
  }
  if (request.actions.some((action) => action.type === 'admin-window')) {
    void openAdmin([]);
  }

  const meaningful = args.filter((arg) => arg !== '--background');
  if (!meaningful.length) {
    // Start menu / taskbar / Explorer launches have the install dir or System32 as cwd:
    // just bring Lookout up. Tools that launch "an external terminal" (VS Code, Git
    // clients, the lookout shim) pass a real folder: open a tab there.
    const normalized = path.resolve(cwd).toLowerCase();
    const systemRoot = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
    const boring =
      normalized === path.dirname(process.execPath).toLowerCase() ||
      normalized === systemRoot ||
      normalized.startsWith(`${systemRoot}\\system32`) ||
      normalized.startsWith(`${systemRoot}\\syswow64`);
    if (boring) {
      showMain();
      return;
    }
    const target = windows.lastFocusedNormal();
    if (!target) {
      openWindow({}, [{ type: 'new-tab', cwd }]);
      return;
    }
    windows.dispatch(target, { type: 'new-tab', cwd });
    windows.reveal(target);
    return;
  }

  const actions = cliToActions(request);
  await importUserWorkspaces(actions);

  if (!actions.length) {
    showMain();
    return;
  }

  if (request.window === 'new') {
    openWindow({}, actions);
    return;
  }

  const target = (request.window !== 'last' ? windows.get(request.window) : undefined) ?? windows.lastFocusedNormal();
  if (!target) {
    openWindow({}, actions);
    return;
  }

  actions.forEach((action) => windows.dispatch(target, action));
  windows.reveal(target);
}

async function openAdmin(actions: WindowAction[]): Promise<void> {
  if (elevated) {
    openWindow({}, actions.length ? actions : [{ type: 'new-tab' }]);
    return;
  }

  const args = [...paths.launchCommand.args, ...adminLaunchArgs(actions)];
  if (testMode) {
    // UI tests check the request instead of raising a UAC prompt.
    const record = globalThis as { __lookoutAdminLaunches?: string[][] };
    (record.__lookoutAdminLaunches ??= []).push(args);
    return;
  }
  await launchElevated(paths.launchCommand.exe, args);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): ManagedWindow | undefined {
  return windows.fromWebContents(event.sender);
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const managed of windows?.all() ?? []) {
    if (!managed.win.isDestroyed()) {
      managed.win.webContents.send(channel, ...args);
    }
  }
}

async function listRestoredPaneIds(): Promise<string[]> {
  try {
    const entries = await readdir(path.join(app.getPath('userData'), 'buffers'));
    return entries.filter((entry) => entry.endsWith('.vt')).map((entry) => entry.slice(0, -3));
  } catch {
    return [];
  }
}

function registerIpc(): void {
  ipcMain.handle('lookout:bootstrap', async (event): Promise<BootstrapPayload> => {
    const managed = senderWindow(event);
    if (!managed) {
      throw new Error('Unknown window');
    }

    const state = stateStore.get();
    const payload: BootstrapPayload = {
      windowId: managed.id,
      windowKind: managed.kind,
      window: managed.spec,
      settings: settings(),
      settingsPath: settingsStore.path,
      settingsWarnings: lastSettingsWarnings,
      workspaces: state.workspaces,
      recentDirectories: state.recentDirectories,
      appVersion: app.getVersion(),
      windowsBuild,
      elevated,
      isPackaged: app.isPackaged,
      homeDir: os.homedir(),
      restoredPaneIds: await listRestoredPaneIds(),
      pendingActions: windows.takePendingActions(managed),
      notices,
    };
    notices = [];
    windows.markReady(managed);
    return payload;
  });

  ipcMain.on('lookout:request-host-port', (event) => {
    const managed = senderWindow(event);
    if (managed) {
      host.connectWindow(managed.id, event.sender);
    }
  });

  // Window controls
  ipcMain.on('lookout:minimize', (event) => senderWindow(event)?.win.minimize());
  ipcMain.on('lookout:toggle-maximize', (event) => {
    const win = senderWindow(event)?.win;
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });
  ipcMain.on('lookout:close', (event) => senderWindow(event)?.win.close());
  ipcMain.on('lookout:set-fullscreen', (event, enabled?: boolean) => {
    const win = senderWindow(event)?.win;
    if (win) {
      win.setFullScreen(typeof enabled === 'boolean' ? enabled : !win.isFullScreen());
    }
  });
  ipcMain.on('lookout:toggle-devtools', (event) => event.sender.toggleDevTools());
  ipcMain.on('lookout:set-progress', (event, progress: TaskbarProgress) => {
    const win = senderWindow(event)?.win;
    if (!win) {
      return;
    }
    if (progress.mode === 'none') {
      win.setProgressBar(-1);
    } else {
      win.setProgressBar(progress.mode === 'indeterminate' ? 2 : Math.max(0, Math.min(1, progress.value)), { mode: progress.mode });
    }
  });
  ipcMain.on('lookout:flash-frame', (event) => {
    const win = senderWindow(event)?.win;
    if (win && !win.isFocused()) {
      win.flashFrame(true);
    }
  });
  ipcMain.on('lookout:set-title', (event, title: string) => {
    senderWindow(event)?.win.setTitle(typeof title === 'string' && title ? `${title} — Lookout` : 'Lookout');
  });
  ipcMain.on('lookout:close-confirmed', (event) => {
    const managed = senderWindow(event);
    if (managed) {
      managed.closeConfirmed = true;
      managed.win.close();
    }
  });
  ipcMain.on('lookout:save-window', (event, spec: WindowSpec) => {
    const managed = senderWindow(event);
    if (!managed || !spec || typeof spec !== 'object') {
      return;
    }
    managed.spec = {
      ...managed.spec,
      tabs: Array.isArray(spec.tabs) ? spec.tabs : managed.spec.tabs,
      activeTabId: spec.activeTabId ?? null,
      sidebarCollapsed: spec.sidebarCollapsed,
      sidebarWidth: spec.sidebarWidth,
    };
    if (!quitting) {
      stateStore.setWindow(managed.spec);
    }
  });
  ipcMain.on('lookout:new-window', (_event, actions?: WindowAction[]) => {
    openWindow({}, Array.isArray(actions) && actions.length ? actions : [{ type: 'new-tab' }]);
  });
  ipcMain.on('lookout:move-tab-to-new-window', (_event, tab: TabSpec, sessions: Record<string, string>, at?: { x: number; y: number }) => {
    openWindow({}, [{ type: 'adopt-tab', tab, sessions }], { at });
  });
  ipcMain.on('lookout:open-admin-window', (_event, actions?: WindowAction[]) => void openAdmin(Array.isArray(actions) ? actions : []));
  ipcMain.on('lookout:toggle-quake', () => windows.toggleQuake(openQuakeWindow));
  ipcMain.on('lookout:keyboard-layout', (_event, backquoteKey: unknown) => {
    if (typeof backquoteKey === 'string' && backquoteKey.length <= 2 && backquoteKey !== backquoteKeyOnLayout) {
      backquoteKeyOnLayout = backquoteKey;
      if (!testMode) {
        registerHotkeys(settings());
      }
    }
  });
  ipcMain.on('lookout:quit', () => app.quit());

  // Settings
  ipcMain.handle('lookout:set-settings', async (_event, next: LookoutSettings) => {
    const { settings: sanitized, warnings } = sanitizeSettings(next, settings());
    const saved = await settingsStore.update((draft) => {
      Object.assign(draft, sanitized);
    });
    return { settings: saved, warnings };
  });
  ipcMain.on('lookout:open-settings-file', () => {
    void shell.openPath(settingsStore.path);
  });
  ipcMain.handle('lookout:redetect-profiles', async () => {
    const detected = await detectProfiles();
    return settingsStore.update((draft) => {
      draft.profiles = mergeDetectedProfiles(draft.profiles, detected);
    });
  });
  ipcMain.handle('lookout:import-wt', async () => {
    const detected = await detectProfiles();
    const result = await importWindowsTerminal({ detected });
    if (!result) {
      return { settings: settings(), summary: ['No Windows Terminal settings were found.'] };
    }

    const next = await settingsStore.update((draft) => {
      const byId = new Map(draft.profiles.map((profile) => [profile.id, profile]));
      for (const profile of result.profiles) {
        byId.set(profile.id, { ...byId.get(profile.id), ...profile });
      }
      draft.profiles = [...byId.values()];
      const schemeNames = new Set(draft.schemes.map((scheme) => scheme.name));
      draft.schemes = [...draft.schemes, ...result.schemes.filter((scheme) => !schemeNames.has(scheme.name))];
      if (result.defaultProfileId && byId.has(result.defaultProfileId)) {
        draft.defaultProfile = result.defaultProfileId;
      }
      if (result.font) {
        draft.font = { ...draft.font, ...result.font };
      }
      const existingKeys = new Set(draft.keybindings.map((binding) => binding.keys));
      draft.keybindings = [...draft.keybindings, ...result.keybindings.filter((binding) => !existingKeys.has(binding.keys))];
    });

    return {
      settings: next,
      summary: [
        `Imported ${result.profiles.length} profiles and ${result.schemes.length} color schemes from Windows Terminal.`,
        ...result.warnings,
      ],
    };
  });
  ipcMain.handle('lookout:list-fonts', () => listLocalFonts());

  // State
  ipcMain.handle('lookout:get-restored-buffer', async (_event, paneId: string) => {
    if (typeof paneId !== 'string') {
      return null;
    }
    const data = await stateStore.readBuffer(paneId);
    if (data !== null) {
      void stateStore.deleteBuffer(paneId);
    }
    return data;
  });
  ipcMain.on('lookout:save-workspace', (_event, workspace: WorkspaceTemplate) => {
    stateStore.upsertWorkspace(workspace);
    broadcast('lookout:workspaces', stateStore.get().workspaces);
  });
  ipcMain.on('lookout:delete-workspace', (_event, id: string) => {
    stateStore.deleteWorkspace(id);
    broadcast('lookout:workspaces', stateStore.get().workspaces);
  });
  ipcMain.on('lookout:add-recent-directory', (_event, dir: string) => {
    if (typeof dir === 'string' && dir) {
      stateStore.addRecentDirectory(dir);
      broadcast('lookout:recent-directories', stateStore.get().recentDirectories);
    }
  });
  ipcMain.on('lookout:push-closed-tab', (_event, tab: TabSpec) => stateStore.pushClosedTab(tab));
  ipcMain.handle('lookout:pop-closed-tab', () => stateStore.popClosedTab());

  // OS
  ipcMain.on('lookout:open-path', (_event, target: string) => {
    if (typeof target === 'string' && target) {
      void shell.openPath(target);
    }
  });
  ipcMain.on('lookout:open-external', (_event, url: string) => {
    if (typeof url === 'string' && /^(https?|mailto|ftp|file):/i.test(url)) {
      void shell.openExternal(url);
    }
  });
  ipcMain.on('lookout:show-item-in-folder', (_event, target: string) => {
    if (typeof target === 'string' && target) {
      shell.showItemInFolder(target);
    }
  });
  ipcMain.on('lookout:open-in-vscode', (_event, target: string, line?: number, column?: number) => {
    if (typeof target === 'string' && target) {
      openInVsCode(target, line, column);
    }
  });
  ipcMain.handle('lookout:probe-paths', (_event, inputs: string[], cwd: string) => probePaths(inputs, cwd));
  ipcMain.on('lookout:notify', (event, request: NotificationRequest) => {
    const managed = senderWindow(event);
    if (managed) {
      showNotification(managed, request);
    }
  });
  ipcMain.on('lookout:beep', () => shell.beep());

  // Git
  ipcMain.on('lookout:git-watch', (event, cwd: string) => {
    const managed = senderWindow(event);
    if (!managed || typeof cwd !== 'string' || !cwd) {
      return;
    }
    const key = `${managed.id}|${cwd.toLowerCase()}`;
    if (gitSubscriptions.has(key)) {
      return;
    }
    const sender = event.sender;
    gitSubscriptions.set(
      key,
      gitService.watch(cwd, (status) => {
        if (!sender.isDestroyed()) {
          sender.send('lookout:git', cwd, status);
        }
      }),
    );
  });
  ipcMain.on('lookout:git-unwatch', (event, cwd: string) => {
    const managed = senderWindow(event);
    if (!managed || typeof cwd !== 'string') {
      return;
    }
    const key = `${managed.id}|${cwd.toLowerCase()}`;
    gitSubscriptions.get(key)?.();
    gitSubscriptions.delete(key);
  });
  ipcMain.on('lookout:git-refresh', (_event, cwd: string) => {
    if (typeof cwd === 'string' && cwd) {
      gitService.refresh(cwd);
    }
  });

  // Integrations
  ipcMain.handle('lookout:get-integrations', async (): Promise<IntegrationStatus[]> => {
    const ctx = integrationContext();
    const results = await Promise.allSettled([getDefaultTerminalStatus(ctx), getExplorerMenuStatus(ctx), getCliPathStatus(ctx)]);
    const ids: IntegrationId[] = ['defaultTerminal', 'explorerMenu', 'cliOnPath'];
    return results.map((result, index) =>
      result.status === 'fulfilled'
        ? { ...result.value, id: ids[index] }
        : { id: ids[index], enabled: false, available: false, detail: String(result.reason) },
    );
  });
  ipcMain.handle('lookout:set-integration', async (_event, id: IntegrationId, enabled: boolean): Promise<IntegrationStatus> => {
    const ctx = integrationContext();
    try {
      const status =
        id === 'defaultTerminal'
          ? await (enabled ? enableDefaultTerminal(ctx) : disableDefaultTerminal(ctx))
          : id === 'explorerMenu'
            ? await (enabled ? enableExplorerMenu(ctx) : disableExplorerMenu(ctx))
            : await (enabled ? enableCliPath(ctx) : disableCliPath(ctx));
      return { ...status, id };
    } catch (error) {
      return { id, enabled: !enabled, available: true, detail: error instanceof Error ? error.message : String(error) };
    }
  });

  // Updates
  ipcMain.handle('lookout:get-update-state', (): AppUpdateState => updater.getState());
  ipcMain.on('lookout:check-for-updates', () => void updater.check());
  ipcMain.on('lookout:download-update', () => void updater.download());
  ipcMain.on('lookout:install-update', () => void updater.install());
}

function showNotification(managed: ManagedWindow, request: NotificationRequest): void {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: String(request.title ?? 'Lookout'),
    body: String(request.body ?? ''),
    icon: paths.windowIcon,
    silent: true,
  });
  activeNotifications.add(notification);
  notification.on('click', () => {
    const target = windows.get(managed.id);
    if (target) {
      windows.reveal(target);
      windows.dispatch(target, { type: 'focus-pane', tabId: request.tabId, paneId: request.paneId });
    }
  });
  notification.on('close', () => activeNotifications.delete(notification));
  notification.show();
}

async function probePaths(inputs: unknown, cwd: unknown): Promise<PathProbe[]> {
  if (!Array.isArray(inputs) || typeof cwd !== 'string') {
    return [];
  }

  const home = os.homedir();
  return Promise.all(
    inputs.slice(0, 64).map(async (raw): Promise<PathProbe> => {
      const input = String(raw);
      let candidate = input.replace(/^["']|["']$/g, '');
      if (candidate.startsWith('~')) {
        candidate = path.join(home, candidate.slice(1));
      }
      if (/^\/[a-z]\//i.test(candidate)) {
        // Git Bash style /c/Users/...
        candidate = `${candidate[1]}:${candidate.slice(2)}`;
      }
      const resolved = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
      try {
        const info = await stat(resolved);
        return { input, resolved, isDirectory: info.isDirectory() };
      } catch {
        return { input, resolved: null, isDirectory: false };
      }
    }),
  );
}

function openInVsCode(target: string, line?: number, column?: number): void {
  const location = line ? `${target}:${line}${column ? `:${column}` : ''}` : target;
  const args = line ? ['-g', location] : [target];
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  const tryNext = (index: number) => {
    if (index >= candidates.length) {
      void shell.openExternal(`vscode://file${pathToFileURL(target).pathname}${line ? `:${line}${column ? `:${column}` : ''}` : ''}`);
      return;
    }
    execFile(candidates[index], args, { windowsHide: true }, (error) => {
      if (error) {
        tryNext(index + 1);
      }
    });
  };
  tryNext(0);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
  const data = additionalData as { argv?: string[]; cwd?: string } | undefined;
  void handleSecondInstance(Array.isArray(data?.argv) ? data.argv : argv, typeof data?.cwd === 'string' ? data.cwd : workingDirectory);
});

app.on('window-all-closed', () => {
  // Stay resident in the tray (instant reopen); quitting is explicit.
  if (testMode || !settingsStore || !settings().window.keepRunningInTray) {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitReady || !host) {
    return;
  }

  event.preventDefault();
  if (quitting) {
    return;
  }

  quitting = true;
  const shutdown = async () => {
    await persistBuffers();
    for (const managed of windows.all()) {
      stateStore.setWindow(managed.spec);
    }
    await stateStore.flush();
    await host.killAll();
  };

  void Promise.race([shutdown(), new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() => {
    quitReady = true;
    host.dispose();
    gitService.dispose();
    globalShortcut.unregisterAll();
    if (elevated) {
      removeInstanceMarker(path.join(app.getPath('userData'), INSTANCE_MARKER_FILE));
    }
    app.quit();
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

if (gotLock) {
  app.whenReady().then(() => {
    void bootstrap().catch((error: unknown) => {
      console.error('[lookout] bootstrap failed', error);
      for (const contents of allWebContents.getAllWebContents()) {
        contents.close();
      }
      app.exit(1);
    });
  });
}
