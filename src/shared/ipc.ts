// Bridge between the renderer and the Electron main process (exposed by the
// preload script as `window.lookout`). Terminal data does NOT go through here:
// each window gets a MessagePort to the pty host, delivered via
// `window.postMessage('lookout:host-port', '*', [port])` from the preload.

import type { CommandId } from './commands';
import type { SessionInfo } from './host-protocol';
import type { LookoutSettings } from './settings';
import type { TabSpec, WindowSpec, WorkspaceTemplate } from './session';

export const HOST_PORT_MESSAGE = 'lookout:host-port';

export interface GitStatus {
  repoRoot: string;
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export type IntegrationId = 'defaultTerminal' | 'explorerMenu' | 'cliOnPath';

export interface IntegrationStatus {
  id: IntegrationId;
  enabled: boolean;
  available: boolean;
  detail?: string;
}

export type AppUpdatePhase = 'idle' | 'unsupported' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  downloadedFile?: string;
  checkedAt?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

/** Things main asks a window to do (CLI, tray, handoff, notifications, tab transfer). */
export type WindowAction =
  | { type: 'new-tab'; profileId?: string; cwd?: string; title?: string; tabColor?: string; commandline?: string }
  | { type: 'split-pane'; direction: 'right' | 'down' | 'auto'; size?: number; profileId?: string; cwd?: string; title?: string; commandline?: string }
  | { type: 'focus-tab'; index: number }
  | { type: 'open-workspace'; nameOrId: string }
  | { type: 'open-settings'; section?: string }
  | { type: 'adopt-session'; session: SessionInfo }
  | { type: 'adopt-tab'; tab: TabSpec; sessions: Record<string, string> }
  | { type: 'focus-pane'; tabId: string; paneId: string }
  | { type: 'command'; command: CommandId; args?: Record<string, string | number | boolean> };

export interface BootstrapPayload {
  windowId: string;
  windowKind: 'normal' | 'quake';
  window: WindowSpec;
  settings: LookoutSettings;
  settingsPath: string;
  settingsWarnings: string[];
  workspaces: WorkspaceTemplate[];
  recentDirectories: string[];
  appVersion: string;
  windowsBuild: number;
  elevated: boolean;
  isPackaged: boolean;
  homeDir: string;
  /** Pane ids that have a serialized buffer from the previous run. */
  restoredPaneIds: string[];
  /** Actions queued for this window when it was created (CLI args, moved tab). */
  pendingActions: WindowAction[];
  /** One-time messages, e.g. what was imported from Windows Terminal on first run. */
  notices: string[];
}

export interface WindowFlags {
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

export interface TaskbarProgress {
  mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused';
  /** 0..1 */
  value: number;
}

export interface PathProbe {
  /** The text as it appeared in the terminal. */
  input: string;
  /** Absolute path if it exists. */
  resolved: string | null;
  isDirectory: boolean;
}

export interface NotificationRequest {
  title: string;
  body: string;
  tabId: string;
  paneId: string;
}

export type Unsubscribe = () => void;

export interface LookoutBridge {
  bootstrap(): Promise<BootstrapPayload>;
  getPathForFile(file: File): string;

  // Window
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  setFullscreen(enabled?: boolean): void;
  toggleDevTools(): void;
  setProgress(progress: TaskbarProgress): void;
  flashFrame(): void;
  setTitle(title: string): void;
  onWindowFlags(listener: (flags: WindowFlags) => void): Unsubscribe;
  /** Main asks before closing; reply with `closeConfirmed()` or ignore to cancel. */
  onCloseRequested(listener: () => void): Unsubscribe;
  closeConfirmed(): void;
  saveWindow(spec: WindowSpec): void;
  newWindow(actions?: WindowAction[]): void;
  moveTabToNewWindow(tab: TabSpec, sessions: Record<string, string>, screenPoint?: { x: number; y: number }): void;
  openAdminWindow(actions?: WindowAction[]): void;
  toggleQuake(): void;
  /** What the physical key left of 1 types on this keyboard layout (for layout-correct global hotkeys). */
  reportKeyboardLayout(backquoteKey: string): void;
  quit(): void;
  onAction(listener: (action: WindowAction) => void): Unsubscribe;
  /** Ask main for a fresh pty-host port (e.g. after the host restarted). */
  requestHostPort(): void;

  // Settings
  setSettings(next: LookoutSettings): Promise<{ settings: LookoutSettings; warnings: string[] }>;
  onSettings(listener: (settings: LookoutSettings, warnings: string[]) => void): Unsubscribe;
  openSettingsFile(): void;
  redetectProfiles(): Promise<LookoutSettings>;
  importWindowsTerminal(): Promise<{ settings: LookoutSettings; summary: string[] }>;
  listFonts(): Promise<string[]>;

  // State
  getRestoredBuffer(paneId: string): Promise<string | null>;
  saveWorkspace(workspace: WorkspaceTemplate): void;
  deleteWorkspace(id: string): void;
  onWorkspaces(listener: (workspaces: WorkspaceTemplate[]) => void): Unsubscribe;
  addRecentDirectory(dir: string): void;
  onRecentDirectories(listener: (dirs: string[]) => void): Unsubscribe;
  pushClosedTab(tab: TabSpec): void;
  popClosedTab(): Promise<TabSpec | null>;

  // OS
  openPath(target: string): void;
  openExternal(url: string): void;
  showItemInFolder(target: string): void;
  openInVSCode(target: string, line?: number, column?: number): void;
  probePaths(inputs: string[], cwd: string): Promise<PathProbe[]>;
  notify(request: NotificationRequest): void;
  beep(): void;

  // Git
  gitWatch(cwd: string): void;
  gitUnwatch(cwd: string): void;
  gitRefresh(cwd: string): void;
  onGit(listener: (cwd: string, status: GitStatus | null) => void): Unsubscribe;

  // Integrations
  getIntegrations(): Promise<IntegrationStatus[]>;
  setIntegration(id: IntegrationId, enabled: boolean): Promise<IntegrationStatus>;

  // Updates
  getUpdateState(): Promise<AppUpdateState>;
  checkForUpdates(): void;
  downloadUpdate(): void;
  installUpdate(): void;
  onUpdateState(listener: (state: AppUpdateState) => void): Unsubscribe;
}
