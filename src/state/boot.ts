import type { SessionInfo } from '../shared/host-protocol';
import type { TaskbarProgress } from '../shared/ipc';
import { DEFAULT_SIDEBAR_WIDTH, getState, gitKey, patchRuntime, pushToast, setState, useApp, type TabRuntime } from './store';
import {
  broadcastTargets,
  closePane,
  commandFinished,
  confirmPaste,
  findProfile,
  getActiveTab,
  getKeymap,
  handleWindowAction,
  hydrateTab,
  isPaneVisible,
  newTab,
  paneNotification,
  requestWindowClose,
  restartPane,
  runCommand,
  snapshotWindow,
  tabTitle,
} from './actions';
import { eventChord, isAltGr } from '../terminal/keymap';
import { terminals } from '../terminal/terminal-manager';

let booted = false;

export async function boot(): Promise<void> {
  if (booted) {
    return;
  }
  booted = true;

  const bridge = window.lookout;
  if (!bridge) {
    setState({ bootError: 'The Electron preload bridge is unavailable.' });
    return;
  }

  // Listeners first, so nothing sent during boot is lost.
  const queuedActions: Parameters<typeof handleWindowAction>[0][] = [];
  let actionsReady = false;
  bridge.onAction((action) => (actionsReady ? handleWindowAction(action) : queuedActions.push(action)));
  bridge.onSettings((settings, warnings) => {
    setState({ settings, settingsWarnings: warnings });
    terminals.applySettings(settings, (paneId) => {
      const tab = getState().tabs.find((entry) => paneId in entry.panes);
      return tab ? findProfile(tab.panes[paneId].profileId) : undefined;
    });
  });
  bridge.onWorkspaces((workspaces) => setState({ workspaces }));
  bridge.onRecentDirectories((recentDirectories) => setState({ recentDirectories }));
  bridge.onGit((cwd, status) => setState((state) => ({ git: { ...state.git, [gitKey(cwd)]: status } })));
  bridge.onWindowFlags((flags) => {
    setState({ flags });
    if (!flags.focused) {
      terminals.blurAll();
    } else {
      const tab = getActiveTab();
      if (tab) {
        patchRuntime(tab.focusedPaneId, { bell: false, activity: false });
      }
    }
  });
  bridge.onCloseRequested(() => requestWindowClose());
  bridge.onUpdateState((update) => {
    const blockedBefore = getState().update.phase === 'downloaded' ? getState().update.error : undefined;
    setState({ update });
    // "Restart to install" was held back (the administrator window is open).
    if (update.phase === 'downloaded' && update.error && update.error !== blockedBefore) {
      pushToast({ tone: 'info', title: 'Update waiting', body: update.error });
    }
  });

  let payload;
  try {
    payload = await bridge.bootstrap();
  } catch (error) {
    setState({ bootError: error instanceof Error ? error.message : String(error) });
    return;
  }

  const tabs: TabRuntime[] = payload.window.tabs.map((tab) => ({ ...tab, zoomedPaneId: null, broadcast: false }));
  setState({
    windowId: payload.windowId,
    windowKind: payload.windowKind,
    elevated: payload.elevated,
    homeDir: payload.homeDir,
    appVersion: payload.appVersion,
    windowsBuild: payload.windowsBuild,
    settingsPath: payload.settingsPath,
    settings: payload.settings,
    settingsWarnings: payload.settingsWarnings,
    workspaces: payload.workspaces,
    recentDirectories: payload.recentDirectories,
    restoredPaneIds: new Set(payload.restoredPaneIds),
    // The drop-down terminal starts with the slim rail: it is about the terminal.
    sidebarCollapsed: payload.window.sidebarCollapsed ?? payload.windowKind === 'quake',
    sidebarWidth: payload.window.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
    tabs,
    activeTabId: payload.window.activeTabId && tabs.some((tab) => tab.id === payload.window.activeTabId) ? payload.window.activeTabId : (tabs[0]?.id ?? null),
  });

  terminals.init({
    settings: payload.settings,
    windowsBuild: payload.windowsBuild,
    hooks: {
      closePane: (paneId) => closePane(paneId, { force: true }),
      restartPane: (paneId) => restartPane(paneId),
      confirmPaste,
      broadcastTargets,
      isPaneVisible,
      notify: paneNotification,
      openContextMenu: (paneId, x, y) => window.dispatchEvent(new CustomEvent('lookout:pane-menu', { detail: { paneId, x, y } })),
      onCommandFinished: commandFinished,
      showLinkHint: (text, x, y) => window.dispatchEvent(new CustomEvent('lookout:link-hint', { detail: { text, x, y } })),
    },
  });

  terminals.host.onConnected = (isReconnect) => {
    if (!isReconnect) {
      return;
    }
    // The pty host restarted: every session is gone.
    for (const [paneId, runtime] of Object.entries(getState().runtime)) {
      if (runtime.sessionId) {
        patchRuntime(paneId, { status: 'exited', sessionId: undefined, exitCode: -1 });
      }
    }
    pushToast({ tone: 'error', title: 'The terminal host restarted', body: 'Press Enter in a pane to start a new shell.' });
  };
  bridge.requestHostPort();
  await terminals.host.whenConnected();

  // Renderer reload: reattach to sessions that are still alive.
  const live = new Map<string, SessionInfo>();
  for (const session of await terminals.host.list()) {
    if (session.paneId) {
      live.set(session.paneId, session);
    }
  }
  await Promise.all(tabs.map((tab) => hydrateTab(tab, live)));

  installKeyboard();
  installPersistence();
  installTaskbarAndTitle();
  installGitWatching();

  // Read-only debug handle for automated UI tests (the renderer is sandboxed).
  Object.assign(window, {
    __lookoutDebug: {
      state: getState,
      bufferText: (paneId: string) => terminals.bufferText(paneId),
      info: (paneId: string) => terminals.debugInfo(paneId),
      run: (command: Parameters<typeof runCommand>[0], args?: Parameters<typeof runCommand>[1]) => runCommand(command, args),
    },
  });

  setState({ ready: true });
  actionsReady = true;
  for (const action of [...payload.pendingActions, ...queuedActions.splice(0)]) {
    handleWindowAction(action);
  }

  if (!getState().tabs.length) {
    newTab();
  }

  if (payload.notices.length) {
    // First run: one calm summary instead of a toast per imported/skipped item.
    const isSkip = (line: string) => /skipp|unsupported|not installed/i.test(line);
    const skipped = payload.notices.filter(isSkip).length;
    const details = payload.notices.filter((line) => !isSkip(line) && !/^Terminal font:/i.test(line)).slice(0, 4);
    if (skipped) {
      details.push(`${skipped} Windows Terminal profile${skipped === 1 ? ' was' : 's were'} skipped (not available on this PC).`);
    }
    pushToast({ tone: 'success', title: 'Lookout is set up', body: details.join('\n') || undefined, timeoutMs: 12000 });
  }
  if (payload.settingsWarnings.length) {
    pushToast({ tone: 'error', title: 'Some settings were ignored', body: payload.settingsWarnings.slice(0, 3).join('\n'), timeoutMs: 10000 });
  }

  void bridge.getUpdateState().then((update) => setState({ update }));

  // One-time hint for the spatial pane controls.
  try {
    if (!localStorage.getItem('lookout.tip.paneAnchors')) {
      localStorage.setItem('lookout.tip.paneAnchors', '1');
      window.setTimeout(() => {
        pushToast({
          tone: 'info',
          title: 'Split where you look',
          body: 'Move to any edge of a terminal and click + to open a pane on that side (right-click it to pick a profile).\nDrag a pane by its header to dock it, swap it, or move it to another tab or window.',
          timeoutMs: 14000,
        });
      }, 2500);
    }
  } catch {
    // Storage unavailable: skip the tip.
  }

  // Tell main what the key left of 1 types here, so Win+` works on every layout.
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
  void keyboard
    ?.getLayoutMap()
    .then((layout) => {
      const key = layout.get('Backquote');
      if (key) {
        bridge.reportKeyboardLayout(key);
      }
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.classList.contains('xterm-helper-textarea')) {
    return false;
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const ALWAYS_GLOBAL = new Set(['commandPalette', 'openSettings', 'newTab', 'newWindow', 'nextTab', 'prevTab', 'switchToTab', 'toggleSidebar', 'toggleFullscreen', 'toggleDevTools']);

function installKeyboard(): void {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || event.isComposing || event.key === 'Process') {
        return;
      }
      // Settings is recording a shortcut: let the recorder have every key.
      if (document.documentElement.hasAttribute('data-lookout-recording')) {
        return;
      }
      // Nothing focused (e.g. the instant after a dialog closed): typing belongs to the
      // terminal. Focusing now routes this key's character into it instead of losing it.
      const uiNow = getState().ui;
      if ((event.target === document.body || event.target === document.documentElement) && !uiNow.palette && !uiNow.dialog && !uiNow.contextMenu && !uiNow.settingsOpen) {
        const tab = getActiveTab();
        if (tab) {
          terminals.focus(tab.focusedPaneId);
        }
      }
      // AltGr characters (@ { [ ] } \ $ € on Nordic layouts) must always reach the shell.
      if (isAltGr(event)) {
        return;
      }

      const chord = eventChord(event);
      if (!chord) {
        return;
      }

      const binding = getKeymap().get(chord);
      if (!binding) {
        return;
      }

      const { ui } = getState();
      const editable = isEditableTarget(event.target);
      const overlayOpen = Boolean(ui.palette || ui.dialog || ui.settingsOpen || ui.contextMenu);
      if ((editable || overlayOpen) && !ALWAYS_GLOBAL.has(binding.command)) {
        return;
      }

      if (runCommand(binding.command, binding.args)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  window.addEventListener('blur', () => terminals.blurAll());
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function installPersistence(): void {
  let timer: number | null = null;
  const save = () => {
    timer = null;
    window.lookout.saveWindow(snapshotWindow());
  };
  const schedule = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(save, 150);
  };

  let previousTabs = getState().tabs;
  let previousActive = getState().activeTabId;
  let previousSidebar = `${getState().sidebarCollapsed}|${getState().sidebarWidth}`;
  let previousCwds = cwdSignature();
  useApp.subscribe((state) => {
    const sidebar = `${state.sidebarCollapsed}|${state.sidebarWidth}`;
    const cwds = cwdSignature();
    if (state.tabs !== previousTabs || state.activeTabId !== previousActive || sidebar !== previousSidebar || cwds !== previousCwds) {
      previousTabs = state.tabs;
      previousActive = state.activeTabId;
      previousSidebar = sidebar;
      previousCwds = cwds;
      schedule();
    }
  });

  window.addEventListener('beforeunload', save);
  save();
}

function cwdSignature(): string {
  const { runtime } = getState();
  return Object.keys(runtime)
    .map((paneId) => `${paneId}=${runtime[paneId].cwd ?? ''}`)
    .join('|');
}

// ---------------------------------------------------------------------------
// Taskbar progress & window title
// ---------------------------------------------------------------------------

function installTaskbarAndTitle(): void {
  let lastProgress = '';
  let lastTitle = '';

  const update = () => {
    const state = getState();
    let progress: TaskbarProgress = { mode: 'none', value: 0 };
    const rank = { none: 0, normal: 1, paused: 2, indeterminate: 3, error: 4 } as const;
    for (const runtime of Object.values(state.runtime)) {
      if (!runtime.progress) {
        continue;
      }
      const mode: TaskbarProgress['mode'] =
        runtime.progress.state === 2 ? 'error' : runtime.progress.state === 3 ? 'indeterminate' : runtime.progress.state === 4 ? 'paused' : 'normal';
      if (rank[mode] > rank[progress.mode]) {
        progress = { mode, value: runtime.progress.value / 100 };
      }
    }

    const key = `${progress.mode}|${progress.value}`;
    if (key !== lastProgress) {
      lastProgress = key;
      window.lookout.setProgress(progress);
    }

    const tab = getActiveTab();
    const title = tab ? tabTitle(tab) : '';
    if (title !== lastTitle) {
      lastTitle = title;
      window.lookout.setTitle(title);
    }
  };

  useApp.subscribe(update);
  update();
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function installGitWatching(): void {
  const watched = new Set<string>();

  const sync = () => {
    const state = getState();
    const wanted = new Set<string>();
    if (state.settings.gitStatus) {
      for (const tab of state.tabs) {
        for (const paneId of Object.keys(tab.panes)) {
          const cwd = state.runtime[paneId]?.cwd;
          if (cwd && state.runtime[paneId]?.shellKind !== 'ssh') {
            wanted.add(cwd);
          }
        }
      }
    }

    for (const cwd of wanted) {
      if (!watched.has(cwd)) {
        watched.add(cwd);
        window.lookout.gitWatch(cwd);
      }
    }
    for (const cwd of [...watched]) {
      if (!wanted.has(cwd)) {
        watched.delete(cwd);
        window.lookout.gitUnwatch(cwd);
      }
    }
  };

  let timer: number | null = null;
  useApp.subscribe(() => {
    if (timer === null) {
      timer = window.setTimeout(() => {
        timer = null;
        sync();
      }, 300);
    }
  });
  sync();
}
