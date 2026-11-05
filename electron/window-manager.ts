import { BrowserWindow, nativeTheme, screen, shell, type Rectangle } from 'electron';

import type { WindowAction, WindowFlags } from '../src/shared/ipc';
import type { LookoutSettings } from '../src/shared/settings';
import { newId, type WindowSpec } from '../src/shared/session';
import { DARK_THEME_INFO, LIGHT_CHROME } from '../src/shared/themes';
import { paths } from './paths';

export interface ManagedWindow {
  id: string;
  kind: 'normal' | 'quake';
  win: BrowserWindow;
  /** Latest snapshot (tabs from the renderer, bounds tracked here). */
  spec: WindowSpec;
  pendingActions: WindowAction[];
  closeConfirmed: boolean;
  lastFocusedAt: number;
  rendererReady: boolean;
}

export interface WindowManagerDeps {
  getSettings: () => LookoutSettings;
  onWindowReady: (managed: ManagedWindow) => void;
  onSpecChanged: (managed: ManagedWindow) => void;
  /** Called after a window is gone. `last` is true when it was the last normal window. */
  onWindowClosed: (managed: ManagedWindow, last: boolean) => void;
  isQuitting: () => boolean;
}

const DEFAULT_SIZE = { width: 1280, height: 800 };
const CLOSE_REPLY_TIMEOUT_MS = 4000;

/** Window background and native caption-button colours (they sit on the title strip, --chrome). */
function chromeColors(settings: LookoutSettings): { background: string; caption: string; symbol: string } {
  if (resolveAppTheme(settings) === 'light') {
    return { background: LIGHT_CHROME.background, caption: LIGHT_CHROME.chrome, symbol: LIGHT_CHROME.symbol };
  }
  const dark = DARK_THEME_INFO[settings.darkTheme] ?? DARK_THEME_INFO.night;
  return { background: dark.background, caption: dark.chrome, symbol: dark.symbol };
}

export function resolveAppTheme(settings: LookoutSettings): 'dark' | 'light' {
  if (settings.appTheme === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  return settings.appTheme;
}

export class WindowManager {
  private readonly windows = new Map<string, ManagedWindow>();
  private focusCounter = 0;

  private readonly deps: WindowManagerDeps;

  constructor(deps: WindowManagerDeps) {
    this.deps = deps;
  }

  all(): ManagedWindow[] {
    return [...this.windows.values()];
  }

  normalWindows(): ManagedWindow[] {
    return this.all().filter((managed) => managed.kind === 'normal');
  }

  get(id: string): ManagedWindow | undefined {
    return this.windows.get(id);
  }

  fromWebContents(webContents: Electron.WebContents): ManagedWindow | undefined {
    return this.all().find((managed) => !managed.win.isDestroyed() && managed.win.webContents.id === webContents.id);
  }

  lastFocusedNormal(): ManagedWindow | undefined {
    return this.normalWindows().sort((left, right) => right.lastFocusedAt - left.lastFocusedAt)[0];
  }

  quake(): ManagedWindow | undefined {
    return this.all().find((managed) => managed.kind === 'quake');
  }

  create(spec: Partial<WindowSpec> & { kind?: 'normal' | 'quake' }, actions: WindowAction[] = [], options: { show?: boolean; at?: { x: number; y: number } } = {}): ManagedWindow {
    const settings = this.deps.getSettings();
    const colors = chromeColors(settings);
    const kind = spec.kind ?? 'normal';
    const fullSpec: WindowSpec = {
      id: spec.id ?? newId(),
      kind,
      bounds: spec.bounds,
      maximized: spec.maximized,
      sidebarCollapsed: spec.sidebarCollapsed,
      sidebarWidth: spec.sidebarWidth,
      tabs: spec.tabs ?? [],
      activeTabId: spec.activeTabId ?? null,
    };

    const bounds = kind === 'quake' ? quakeBounds(settings) : this.resolveBounds(fullSpec.bounds, options.at);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 420,
      minHeight: 240,
      show: false,
      frame: false,
      ...(kind === 'normal'
        ? {
            titleBarStyle: 'hidden' as const,
            // Native caption buttons: keeps Windows 11 snap layouts on the maximize button.
            titleBarOverlay: { color: colors.caption, symbolColor: colors.symbol, height: 34 },
          }
        : { skipTaskbar: true, resizable: true, movable: false, minimizable: false, maximizable: false }),
      backgroundColor: colors.background,
      icon: paths.windowIcon,
      title: 'Lookout',
      autoHideMenuBar: true,
      webPreferences: {
        preload: paths.preload,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        // Terminals in background windows must keep parsing output (and acking it),
        // otherwise flow control would pause their shells.
        backgroundThrottling: false,
        additionalArguments: [`--lookout-window-id=${fullSpec.id}`],
      },
    });

    const managed: ManagedWindow = {
      id: fullSpec.id,
      kind,
      win,
      spec: fullSpec,
      pendingActions: [...actions],
      closeConfirmed: false,
      lastFocusedAt: ++this.focusCounter,
      rendererReady: false,
    };
    this.windows.set(managed.id, managed);

    if (kind === 'normal' && fullSpec.maximized) {
      win.maximize();
    }

    this.wire(managed);
    void this.load(win);

    if (options.show !== false) {
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      });
    }

    return managed;
  }

  private resolveBounds(saved: WindowSpec['bounds'], at?: { x: number; y: number }): Rectangle {
    if (at) {
      return { x: Math.round(at.x - 120), y: Math.round(at.y - 16), width: saved?.width ?? DEFAULT_SIZE.width, height: saved?.height ?? DEFAULT_SIZE.height };
    }

    if (saved) {
      const display = screen.getDisplayMatching(saved);
      const area = display.workArea;
      const visible =
        saved.x + saved.width > area.x + 40 && saved.x < area.x + area.width - 40 && saved.y >= area.y - 10 && saved.y < area.y + area.height - 40;
      if (visible) {
        return saved;
      }
    }

    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(DEFAULT_SIZE.width, area.width - 40);
    const height = Math.min(DEFAULT_SIZE.height, area.height - 40);
    // Cascade new windows a little so they don't stack exactly.
    const offset = (this.normalWindows().length % 6) * 28;
    return {
      x: Math.round(area.x + (area.width - width) / 2 + offset),
      y: Math.round(area.y + (area.height - height) / 2 + offset),
      width,
      height,
    };
  }

  private async load(win: BrowserWindow): Promise<void> {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (!devServerUrl) {
      await win.loadFile(paths.rendererIndex);
      return;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await win.loadURL(devServerUrl);
        if (process.env.LOOKOUT_DEVTOOLS === '1') {
          win.webContents.openDevTools({ mode: 'detach' });
        }
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private wire(managed: ManagedWindow): void {
    const { win } = managed;
    const webContents = win.webContents;

    webContents.on('will-navigate', (event, url) => {
      if (url !== webContents.getURL()) {
        event.preventDefault();
      }
    });
    webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    webContents.on('did-start-loading', () => {
      managed.rendererReady = false;
    });
    webContents.on('render-process-gone', () => {
      managed.rendererReady = false;
    });

    let boundsTimer: NodeJS.Timeout | null = null;
    const trackBounds = () => {
      if (boundsTimer) {
        clearTimeout(boundsTimer);
      }
      boundsTimer = setTimeout(() => {
        if (win.isDestroyed() || managed.kind === 'quake') {
          return;
        }
        managed.spec.maximized = win.isMaximized();
        if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
          managed.spec.bounds = win.getBounds();
        }
        this.deps.onSpecChanged(managed);
      }, 250);
    };

    win.on('resize', trackBounds);
    win.on('move', trackBounds);
    win.on('maximize', () => {
      trackBounds();
      this.sendFlags(managed);
    });
    win.on('unmaximize', () => {
      trackBounds();
      this.sendFlags(managed);
    });
    win.on('enter-full-screen', () => this.sendFlags(managed));
    win.on('leave-full-screen', () => this.sendFlags(managed));
    win.on('focus', () => {
      managed.lastFocusedAt = ++this.focusCounter;
      win.flashFrame(false);
      this.sendFlags(managed);
    });
    win.on('blur', () => this.sendFlags(managed));

    win.on('close', (event) => {
      if (this.deps.isQuitting() || managed.closeConfirmed) {
        return;
      }

      event.preventDefault();
      if (!managed.rendererReady || webContents.isCrashed()) {
        managed.closeConfirmed = true;
        win.close();
        return;
      }

      // Let the renderer confirm (running processes); force-close if it never answers.
      webContents.send('lookout:close-requested');
      const timer = setTimeout(() => {
        if (!win.isDestroyed() && !managed.closeConfirmed && webContents.isCrashed()) {
          managed.closeConfirmed = true;
          win.close();
        }
      }, CLOSE_REPLY_TIMEOUT_MS);
      win.once('closed', () => clearTimeout(timer));
    });

    win.on('closed', () => {
      this.windows.delete(managed.id);
      const last = managed.kind === 'normal' && this.normalWindows().length === 0;
      this.deps.onWindowClosed(managed, last);
    });
  }

  markReady(managed: ManagedWindow): void {
    managed.rendererReady = true;
    this.deps.onWindowReady(managed);
  }

  sendFlags(managed: ManagedWindow): void {
    if (managed.win.isDestroyed()) {
      return;
    }

    const flags: WindowFlags = {
      maximized: managed.win.isMaximized(),
      fullscreen: managed.win.isFullScreen(),
      focused: managed.win.isFocused(),
    };
    managed.win.webContents.send('lookout:window-flags', flags);
  }

  /** Delivers an action to a window, queueing it until the renderer has booted. */
  dispatch(managed: ManagedWindow, action: WindowAction): void {
    if (managed.rendererReady && !managed.win.isDestroyed()) {
      managed.win.webContents.send('lookout:action', action);
    } else {
      managed.pendingActions.push(action);
    }
  }

  takePendingActions(managed: ManagedWindow): WindowAction[] {
    const actions = managed.pendingActions;
    managed.pendingActions = [];
    return actions;
  }

  reveal(managed: ManagedWindow): void {
    const { win } = managed;
    if (win.isDestroyed()) {
      return;
    }

    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }

  toggleQuake(create: () => ManagedWindow): void {
    let managed = this.quake();
    if (!managed) {
      managed = create();
      return;
    }

    const { win } = managed;
    if (win.isVisible() && win.isFocused()) {
      win.hide();
      return;
    }

    win.setBounds(quakeBounds(this.deps.getSettings()));
    win.show();
    win.focus();
  }

  applyTheme(settings: LookoutSettings): void {
    const colors = chromeColors(settings);
    for (const managed of this.all()) {
      if (managed.win.isDestroyed()) {
        continue;
      }
      managed.win.setBackgroundColor(colors.background);
      if (managed.kind === 'normal') {
        try {
          managed.win.setTitleBarOverlay({ color: colors.caption, symbolColor: colors.symbol, height: 34 });
        } catch {
          // Overlay not available (e.g. Windows 10 builds without WCO): ignore.
        }
      }
    }
  }
}

function quakeBounds(settings: LookoutSettings): Rectangle {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const percent = Math.min(90, Math.max(20, settings.quake.heightPercent));
  return { x: area.x, y: area.y, width: area.width, height: Math.round((area.height * percent) / 100) };
}
