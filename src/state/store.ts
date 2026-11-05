import { create } from 'zustand';

import { createDefaultSettings } from '../shared/settings-defaults';
import type { AppUpdateState, GitStatus, WindowFlags } from '../shared/ipc';
import type { LookoutSettings, ShellKind } from '../shared/settings';
import type { TabSpec, WorkspaceTemplate } from '../shared/session';

export type PaneStatus = 'starting' | 'running' | 'exited' | 'error';

export interface CommandSummary {
  command?: string;
  exitCode?: number;
  durationMs?: number;
  endedAt: number;
}

export interface PaneRuntime {
  sessionId?: string;
  status: PaneStatus;
  exitCode?: number;
  error?: string;
  shellKind?: ShellKind;
  integrated: boolean;
  /** Live working directory (shell integration) or launch directory. */
  cwd?: string;
  /** Title set by the running program (OSC 0/2). */
  title?: string;
  commandRunning: boolean;
  currentCommand?: string;
  commandStartedAt?: number;
  lastCommand?: CommandSummary;
  /** Enter was pressed since the last prompt (busy heuristic for shells without C marks). */
  inputSincePrompt: boolean;
  progress?: { state: number; value: number };
  activity: boolean;
  bell: boolean;
  restored: boolean;
  kind: 'shell' | 'handoff';
}

export interface TabRuntime extends TabSpec {
  zoomedPaneId: string | null;
  broadcast: boolean;
}

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'error';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  timeoutMs?: number;
}

export interface MenuItem {
  label?: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  run?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export type DialogState =
  | {
      kind: 'confirm';
      title: string;
      message: string;
      detail?: string[];
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
      onCancel?: () => void;
    }
  | { kind: 'paste'; paneId: string; text: string; reason: 'multiline' | 'large' | 'both'; onConfirm: (text: string) => void }
  | { kind: 'prompt'; title: string; label: string; initial: string; confirmLabel: string; onSubmit: (value: string) => void };

export type PaletteMode = 'all' | 'commands' | 'profiles' | 'tabs';

export type DropZone = 'left' | 'right' | 'up' | 'down' | 'center';

/** Where a dragged pane would land if released now. */
export type PaneDropTarget =
  | { kind: 'pane'; paneId: string; zone: DropZone }
  | { kind: 'tab'; tabId: string }
  | { kind: 'newTab' }
  | { kind: 'newWindow' };

export interface PaneDragState {
  paneId: string;
  /** Pointer position (client coordinates) for the ghost. */
  x: number;
  y: number;
  target: PaneDropTarget | null;
}

export interface UiState {
  palette: { mode: PaletteMode; query: string } | null;
  settingsOpen: boolean;
  settingsSection: string;
  findPaneId: string | null;
  renamingTabId: string | null;
  dialog: DialogState | null;
  toasts: Toast[];
  contextMenu: ContextMenuState | null;
  draggingPaneId: string | null;
  draggingTabId: string | null;
  /** A pane being dragged with the pointer (rearranging). */
  paneDrag: PaneDragState | null;
  /** Tab whose divider is being dragged (panes show their size). */
  resizingTabId: string | null;
}

export interface AppState {
  ready: boolean;
  bootError: string | null;
  windowId: string;
  windowKind: 'normal' | 'quake';
  elevated: boolean;
  homeDir: string;
  appVersion: string;
  windowsBuild: number;
  settingsPath: string;
  settings: LookoutSettings;
  settingsWarnings: string[];
  tabs: TabRuntime[];
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  runtime: Record<string, PaneRuntime>;
  git: Record<string, GitStatus | null>;
  workspaces: WorkspaceTemplate[];
  recentDirectories: string[];
  restoredPaneIds: Set<string>;
  flags: WindowFlags;
  update: AppUpdateState;
  ui: UiState;
}

export const DEFAULT_SIDEBAR_WIDTH = 232;

export const useApp = create<AppState>(() => ({
  ready: false,
  bootError: null,
  windowId: '',
  windowKind: 'normal',
  elevated: false,
  homeDir: '',
  appVersion: '',
  windowsBuild: 0,
  settingsPath: '',
  settings: createDefaultSettings(),
  settingsWarnings: [],
  tabs: [],
  activeTabId: null,
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  runtime: {},
  git: {},
  workspaces: [],
  recentDirectories: [],
  restoredPaneIds: new Set(),
  flags: { maximized: false, fullscreen: false, focused: true },
  update: { phase: 'idle', currentVersion: '' },
  ui: {
    palette: null,
    settingsOpen: false,
    settingsSection: 'general',
    findPaneId: null,
    renamingTabId: null,
    dialog: null,
    toasts: [],
    contextMenu: null,
    draggingPaneId: null,
    draggingTabId: null,
    paneDrag: null,
    resizingTabId: null,
  },
}));

export const getState = useApp.getState;
export const setState = useApp.setState;

export function patchUi(patch: Partial<UiState>): void {
  setState((state) => ({ ui: { ...state.ui, ...patch } }));
}

export function patchRuntime(paneId: string, patch: Partial<PaneRuntime>): void {
  setState((state) => {
    const current = state.runtime[paneId];
    if (!current) {
      return state;
    }

    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof PaneRuntime>) {
      if (current[key] !== patch[key]) {
        changed = true;
        break;
      }
    }

    return changed ? { runtime: { ...state.runtime, [paneId]: { ...current, ...patch } } } : state;
  });
}

export function createRuntime(kind: 'shell' | 'handoff' = 'shell'): PaneRuntime {
  return {
    status: 'starting',
    integrated: false,
    commandRunning: false,
    inputSincePrompt: false,
    activity: false,
    bell: false,
    restored: false,
    kind,
  };
}

export function updateTab(tabId: string, update: (tab: TabRuntime) => TabRuntime): void {
  setState((state) => ({ tabs: state.tabs.map((tab) => (tab.id === tabId ? update(tab) : tab)) }));
}

export function findTabOfPane(paneId: string): TabRuntime | undefined {
  return getState().tabs.find((tab) => paneId in tab.panes);
}

export function activeTab(): TabRuntime | undefined {
  const state = getState();
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

let toastCounter = 0;

export function pushToast(toast: Omit<Toast, 'id'>): string {
  const id = `toast-${++toastCounter}`;
  setState((state) => ({ ui: { ...state.ui, toasts: [...state.ui.toasts.slice(-3), { ...toast, id }] } }));
  const timeout = toast.timeoutMs ?? (toast.tone === 'error' ? 9000 : 5000);
  if (timeout > 0) {
    window.setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id: string): void {
  setState((state) => ({ ui: { ...state.ui, toasts: state.ui.toasts.filter((toast) => toast.id !== id) } }));
}

export function gitKey(cwd: string): string {
  return cwd.toLowerCase();
}
