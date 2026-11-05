// Persisted session/window/tab state (state.json). Shared by main and renderer.

export type SplitDirection = 'row' | 'column';

export interface PaneNode {
  type: 'pane';
  paneId: string;
}

export interface SplitNode {
  type: 'split';
  /** `row` lays children out left-to-right, `column` top-to-bottom. */
  direction: SplitDirection;
  children: LayoutNode[];
  /** Fractions that sum to 1, one per child. */
  sizes: number[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface PaneSpec {
  id: string;
  profileId: string;
  /** Last known working directory (from shell integration) or the launch directory. */
  cwd?: string;
  /** User-assigned title; when absent the title follows the running program. */
  title?: string;
  /** Overrides the profile's startup command (used by workspaces and migrated spaces). */
  startupCommand?: string;
  /** Overrides the profile commandline (CLI `new-tab <commandline>`). */
  commandline?: string;
  env?: Record<string, string>;
}

export interface TabSpec {
  id: string;
  /** User-assigned title. */
  title?: string;
  color?: string;
  layout: LayoutNode;
  panes: Record<string, PaneSpec>;
  focusedPaneId: string;
  workspaceId?: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSpec {
  id: string;
  kind: 'normal' | 'quake';
  bounds?: WindowBounds;
  maximized?: boolean;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  tabs: TabSpec[];
  activeTabId: string | null;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  /** Folder the workspace is about; used for search and as default cwd. */
  rootPath?: string;
  layout: LayoutNode;
  panes: Record<string, PaneSpec>;
  /** Opens in the administrator window (after a UAC prompt) instead of the current one. */
  elevate?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedState {
  version: 2;
  windows: WindowSpec[];
  workspaces: WorkspaceTemplate[];
  recentDirectories: string[];
  closedTabs: TabSpec[];
  /** Set once the first-run import/detection has happened. */
  firstRunComplete: boolean;
}

export function createEmptyState(): PersistedState {
  return {
    version: 2,
    windows: [],
    workspaces: [],
    recentDirectories: [],
    closedTabs: [],
    firstRunComplete: false,
  };
}

export function newId(): string {
  return crypto.randomUUID();
}
