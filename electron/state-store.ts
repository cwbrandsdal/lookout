// state.json (windows, tabs, workspaces, recents) and buffers/ (serialized
// scrollback). State is treated immutably: every mutation produces a new
// snapshot, so a value returned by get() is never changed under the caller.

import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';

import { buildGrid, sanitizeLayout } from '../src/shared/layout';
import { createEmptyState, newId } from '../src/shared/session';
import type { LayoutNode, PaneSpec, PersistedState, TabSpec, WindowBounds, WindowSpec, WorkspaceTemplate } from '../src/shared/session';
import { readJsonWithBackup, writeFileAtomic } from './atomic-file';
import { directoryKey, migrateV1, type V1Migration } from './migrate-v1';

export const STATE_FILE_NAME = 'state.json';
export const V1_STATE_FILE_NAME = 'lookout-state.json';
export const V1_MIGRATED_FILE_NAME = 'lookout-state.v1-migrated.json';
export const BUFFERS_DIR_NAME = 'buffers';
export const MAX_RECENT_DIRECTORIES = 20;
export const MAX_CLOSED_TABS = 10;

const BUFFER_EXTENSION = '.vt';
const SAFE_PANE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type StateChangeKind = 'windows' | 'workspaces' | 'recentDirectories' | 'closedTabs' | 'firstRunComplete';

export interface StateChange {
  kind: StateChangeKind;
  state: PersistedState;
}

export interface StateStoreOptions {
  /** Debounce for state.json writes. Default 400 ms. */
  saveDelayMs?: number;
}

// ---- Sanitizer --------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObj(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sanitizePane(value: unknown, key: string): PaneSpec | null {
  if (!isObj(value)) return null;
  const id = text(value.id) ?? text(key);
  const profileId = text(value.profileId);
  if (!id || !profileId) return null;
  const pane: PaneSpec = { id, profileId };
  for (const field of ['cwd', 'title', 'startupCommand', 'commandline'] as const) {
    const entry = text(value[field]);
    if (entry) pane[field] = entry;
  }
  const env = stringRecord(value.env);
  if (env) pane.env = env;
  return pane;
}

function listLeafIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : node.children.flatMap(listLeafIds);
}

/** Validated layout + panes; panes missing from the layout are dropped. Null when nothing is usable. */
function sanitizePaneSet(layoutInput: unknown, panesInput: unknown): { layout: LayoutNode; panes: Record<string, PaneSpec> } | null {
  const panes = new Map<string, PaneSpec>();
  if (isObj(panesInput)) {
    for (const [key, value] of Object.entries(panesInput)) {
      const pane = sanitizePane(value, key);
      if (pane && !panes.has(pane.id)) panes.set(pane.id, pane);
    }
  }
  if (!panes.size) return null;

  // An unusable tree with usable panes is rebuilt as a grid rather than losing the panes.
  const layout = sanitizeLayout(layoutInput, new Set(panes.keys()))
    ?? buildGrid([...panes.keys()], Math.ceil(Math.sqrt(panes.size)));
  const record: Record<string, PaneSpec> = {};
  for (const id of listLeafIds(layout)) record[id] = panes.get(id)!;
  return { layout, panes: record };
}

function sanitizeTab(value: unknown): TabSpec | null {
  if (!isObj(value)) return null;
  const set = sanitizePaneSet(value.layout, value.panes);
  if (!set) return null;
  const ids = Object.keys(set.panes);
  const focused = text(value.focusedPaneId);
  const tab: TabSpec = {
    id: text(value.id) ?? newId(),
    layout: set.layout,
    panes: set.panes,
    focusedPaneId: focused && ids.includes(focused) ? focused : ids[0],
  };
  const title = text(value.title);
  if (title) tab.title = title;
  const color = text(value.color);
  if (color) tab.color = color;
  const workspaceId = text(value.workspaceId);
  if (workspaceId) tab.workspaceId = workspaceId;
  return tab;
}

function sanitizeBounds(value: unknown): WindowBounds | undefined {
  if (!isObj(value)) return undefined;
  const [x, y, width, height] = [value.x, value.y, value.width, value.height].map((entry) =>
    typeof entry === 'number' && Number.isFinite(entry) ? Math.round(entry) : NaN);
  if ([x, y, width, height].some(Number.isNaN) || width < 100 || height < 100) return undefined;
  return { x, y, width, height };
}

/** Pane ids must be unique across live tabs (buffers/<paneId>.vt). Duplicates get new ids. */
function dedupePaneIds(tab: TabSpec, used: Set<string>): TabSpec {
  const map = new Map<string, string>();
  for (const id of Object.keys(tab.panes)) {
    if (used.has(id)) map.set(id, newId());
    used.add(map.get(id) ?? id);
  }
  if (!map.size) return tab;

  const remap = (node: LayoutNode): LayoutNode => node.type === 'pane'
    ? { type: 'pane', paneId: map.get(node.paneId) ?? node.paneId }
    : { ...node, children: node.children.map(remap) };
  const panes: Record<string, PaneSpec> = {};
  for (const [id, pane] of Object.entries(tab.panes)) {
    const next = map.get(id) ?? id;
    panes[next] = { ...pane, id: next };
  }
  return { ...tab, layout: remap(tab.layout), panes, focusedPaneId: map.get(tab.focusedPaneId) ?? tab.focusedPaneId };
}

export function sanitizeWindow(value: unknown, usedPaneIds = new Set<string>()): WindowSpec | null {
  if (!isObj(value)) return null;
  const tabs: TabSpec[] = [];
  const tabIds = new Set<string>();
  for (const rawTab of Array.isArray(value.tabs) ? value.tabs : []) {
    const tab = sanitizeTab(rawTab);
    if (!tab) continue;
    if (tabIds.has(tab.id)) tab.id = newId();
    tabIds.add(tab.id);
    tabs.push(dedupePaneIds(tab, usedPaneIds));
  }

  const active = text(value.activeTabId);
  const window: WindowSpec = {
    id: text(value.id) ?? newId(),
    kind: value.kind === 'quake' ? 'quake' : 'normal',
    tabs,
    activeTabId: active && tabIds.has(active) ? active : tabs[0]?.id ?? null,
  };
  const bounds = sanitizeBounds(value.bounds);
  if (bounds) window.bounds = bounds;
  if (typeof value.maximized === 'boolean') window.maximized = value.maximized;
  if (typeof value.sidebarCollapsed === 'boolean') window.sidebarCollapsed = value.sidebarCollapsed;
  if (typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)) {
    window.sidebarWidth = Math.min(800, Math.max(120, Math.round(value.sidebarWidth)));
  }
  return window;
}

export function sanitizeWorkspace(value: unknown, now = new Date().toISOString()): WorkspaceTemplate | null {
  if (!isObj(value)) return null;
  const set = sanitizePaneSet(value.layout, value.panes);
  if (!set) return null;
  const rootPath = text(value.rootPath);
  const workspace: WorkspaceTemplate = {
    id: text(value.id) ?? newId(),
    name: text(value.name) ?? (rootPath ? win32.basename(rootPath) || rootPath : 'Workspace'),
    layout: set.layout,
    panes: set.panes,
    createdAt: text(value.createdAt) ?? now,
    updatedAt: text(value.updatedAt) ?? now,
  };
  if (rootPath) workspace.rootPath = rootPath;
  if (value.elevate === true) workspace.elevate = true;
  return workspace;
}

/**
 * The workspaces saved by another Lookout instance (the administrator window reads
 * the normal instance's). Read-only and sanitized; an unreadable file gives [].
 */
export async function readWorkspaces(userDataDir: string): Promise<WorkspaceTemplate[]> {
  try {
    const read = await readJsonWithBackup(join(userDataDir, STATE_FILE_NAME));
    return read.source === 'none' ? [] : sanitizeState(read.value).state.workspaces;
  } catch {
    return [];
  }
}

function dedupeDirectories(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const directory = text(value);
    if (!directory || seen.has(directoryKey(directory))) continue;
    seen.add(directoryKey(directory));
    result.push(directory);
  }
  return result.slice(0, MAX_RECENT_DIRECTORIES);
}

/** Validates untrusted state. Tabs and workspaces without a usable pane are dropped; so are windows without tabs. */
export function sanitizeState(input: unknown): { state: PersistedState; warnings: string[] } {
  const warnings: string[] = [];
  const state = createEmptyState();
  if (input === undefined || input === null) return { state, warnings };
  if (!isObj(input)) {
    warnings.push('state.json did not contain an object; starting with an empty session.');
    return { state, warnings };
  }

  const usedPaneIds = new Set<string>();
  const windowIds = new Set<string>();
  const rawWindows = Array.isArray(input.windows) ? input.windows : [];
  let droppedTabs = 0;
  for (const rawWindow of rawWindows) {
    const window = sanitizeWindow(rawWindow, usedPaneIds);
    const rawTabCount = isObj(rawWindow) && Array.isArray(rawWindow.tabs) ? rawWindow.tabs.length : 0;
    droppedTabs += rawTabCount - (window?.tabs.length ?? 0);
    if (!window || !window.tabs.length) continue;
    if (windowIds.has(window.id)) window.id = newId();
    windowIds.add(window.id);
    state.windows.push(window);
  }
  if (droppedTabs > 0) warnings.push(`${droppedTabs} saved tab(s) had no usable panes and were dropped.`);

  const workspaceIds = new Set<string>();
  const rawWorkspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
  for (const rawWorkspace of rawWorkspaces) {
    const workspace = sanitizeWorkspace(rawWorkspace);
    if (!workspace || workspaceIds.has(workspace.id)) continue;
    workspaceIds.add(workspace.id);
    state.workspaces.push(workspace);
  }
  if (state.workspaces.length < rawWorkspaces.length) {
    warnings.push(`${rawWorkspaces.length - state.workspaces.length} saved workspace(s) were invalid and were dropped.`);
  }

  state.recentDirectories = dedupeDirectories(Array.isArray(input.recentDirectories) ? input.recentDirectories : []);
  state.closedTabs = (Array.isArray(input.closedTabs) ? input.closedTabs : [])
    .map(sanitizeTab).filter((tab): tab is TabSpec => tab !== null).slice(0, MAX_CLOSED_TABS);
  state.firstRunComplete = input.firstRunComplete === true;
  return { state, warnings };
}

// ---- Store ------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateFromMigration(migration: V1Migration): PersistedState {
  // v1 project spaces were agent launchers (claude/codex startup commands). Lookout is
  // terminal-first now: keep them all as one-click workspaces, but don't reopen dozens
  // of agent panes on first launch (the first window starts with one fresh tab).
  return {
    ...createEmptyState(),
    windows: [],
    workspaces: migration.workspaces,
    recentDirectories: migration.recentDirectories,
  };
}

export class StateStore {
  readonly path: string;
  readonly buffersDir: string;
  private readonly saveDelayMs: number;
  private state: PersistedState;
  private readonly warnings: string[];
  private readonly v1Migration: V1Migration | null;
  private readonly changeListeners = new Set<(change: StateChange) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(userDataDir: string, state: PersistedState, v1Migration: V1Migration | null, warnings: string[], options: StateStoreOptions) {
    this.path = join(userDataDir, STATE_FILE_NAME);
    this.buffersDir = join(userDataDir, BUFFERS_DIR_NAME);
    this.state = state;
    this.v1Migration = v1Migration;
    this.warnings = warnings;
    this.saveDelayMs = options.saveDelayMs ?? 400;
  }

  static async open(userDataDir: string, options: StateStoreOptions = {}): Promise<StateStore> {
    await mkdir(userDataDir, { recursive: true });
    const warnings: string[] = [];
    const statePath = join(userDataDir, STATE_FILE_NAME);
    const v1Path = join(userDataDir, V1_STATE_FILE_NAME);
    const migratedPath = join(userDataDir, V1_MIGRATED_FILE_NAME);

    const read = await readJsonWithBackup(statePath);
    if (read.source === 'backup') warnings.push(`${read.error ?? `${statePath} was missing.`} The previous session was restored from state.json.bak.`);
    else if (read.error) warnings.push(read.error);

    let state: PersistedState;
    let migration: V1Migration | null = null;
    let migratedNow = false;
    if (read.source !== 'none') {
      const sanitized = sanitizeState(read.value);
      state = sanitized.state;
      warnings.push(...sanitized.warnings);
    } else if (!read.error) {
      // No v2 state at all: migrate v1 if it is there.
      const v1 = await readJsonWithBackup(v1Path);
      if (v1.error) warnings.push(v1.error);
      migration = v1.source === 'none' ? null : migrateV1(v1.value);
      if (v1.source !== 'none' && !migration) warnings.push(`${v1Path} is not a Lookout v1 state file; it was left untouched.`);
      if (migration) {
        state = sanitizeState(stateFromMigration(migration)).state;
        warnings.push(...migration.warnings);
        migratedNow = true;
      } else {
        state = createEmptyState();
      }
    } else {
      state = createEmptyState();
    }

    // Settings first-run may not have completed after an earlier migration (crash, or
    // settings.json lost): offer the archived v1 data again for the settings import.
    if (!migration && !state.firstRunComplete) {
      try {
        migration = migrateV1(JSON.parse((await readFile(migratedPath, 'utf8')).replace(/^\uFEFF/, '')));
      } catch {
        migration = null;
      }
    }

    const store = new StateStore(userDataDir, state, migration, warnings, options);
    if (migratedNow) {
      store.dirty = true;
      await store.flush();
      try {
        await rename(v1Path, migratedPath);
      } catch (error) {
        warnings.push(`Migrated ${v1Path} but could not rename it (${errorMessage(error)}).`);
      }
    }
    return store;
  }

  /** Current snapshot. Never mutate it; use the store methods. */
  get(): PersistedState {
    return this.state;
  }

  /** Problems found while loading (recovered files, dropped entries, migration notes). */
  getLoadWarnings(): string[] {
    return [...this.warnings];
  }

  /** The v1 migration result while settings first-run is still pending; otherwise null. */
  getV1Migration(): V1Migration | null {
    return this.state.firstRunComplete ? null : this.v1Migration;
  }

  onChange(listener: (change: StateChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Save failures (the in-memory state stays authoritative and is retried on the next change). */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Inserts or replaces a window (sanitized). Returns the stored spec, or null if invalid. */
  setWindow(spec: WindowSpec): WindowSpec | null {
    const used = new Set(this.state.windows.filter((window) => window.id !== spec?.id)
      .flatMap((window) => window.tabs.flatMap((tab) => Object.keys(tab.panes))));
    const window = sanitizeWindow(spec, used);
    if (!window) return null;
    const index = this.state.windows.findIndex((entry) => entry.id === window.id);
    const windows = [...this.state.windows];
    if (index >= 0) windows[index] = window;
    else windows.push(window);
    this.commit({ ...this.state, windows }, 'windows');
    return window;
  }

  removeWindow(id: string): void {
    if (!this.state.windows.some((window) => window.id === id)) return;
    this.commit({ ...this.state, windows: this.state.windows.filter((window) => window.id !== id) }, 'windows');
  }

  /** Inserts or replaces a workspace (keeps the original createdAt, bumps updatedAt). */
  upsertWorkspace(workspace: WorkspaceTemplate): WorkspaceTemplate | null {
    const now = new Date().toISOString();
    const sanitized = sanitizeWorkspace(workspace, now);
    if (!sanitized) return null;
    const existing = this.state.workspaces.find((entry) => entry.id === sanitized.id);
    const next: WorkspaceTemplate = { ...sanitized, createdAt: existing?.createdAt ?? sanitized.createdAt, updatedAt: now };
    const workspaces = existing
      ? this.state.workspaces.map((entry) => (entry.id === next.id ? next : entry))
      : [...this.state.workspaces, next];
    this.commit({ ...this.state, workspaces }, 'workspaces');
    return next;
  }

  /**
   * Copies workspaces from another instance, keeping their timestamps. A copy that
   * is the same age or newer here (edited in this instance since) is kept.
   * Returns true when anything changed.
   */
  importWorkspaces(incoming: readonly WorkspaceTemplate[]): boolean {
    let workspaces = this.state.workspaces;
    for (const candidate of incoming) {
      const workspace = sanitizeWorkspace(candidate);
      if (!workspace) continue;
      const existing = workspaces.find((entry) => entry.id === workspace.id);
      if (existing && !(Date.parse(workspace.updatedAt) > Date.parse(existing.updatedAt))) continue;
      workspaces = existing ? workspaces.map((entry) => (entry.id === workspace.id ? workspace : entry)) : [...workspaces, workspace];
    }
    if (workspaces === this.state.workspaces) return false;
    this.commit({ ...this.state, workspaces }, 'workspaces');
    return true;
  }

  deleteWorkspace(id: string): boolean {
    if (!this.state.workspaces.some((workspace) => workspace.id === id)) return false;
    this.commit({ ...this.state, workspaces: this.state.workspaces.filter((workspace) => workspace.id !== id) }, 'workspaces');
    return true;
  }

  /** Most recent first; case- and trailing-slash-insensitive dedupe; at most 20. */
  addRecentDirectory(directory: string): void {
    const trimmed = typeof directory === 'string' ? directory.trim() : '';
    if (!trimmed) return;
    const recentDirectories = dedupeDirectories([trimmed, ...this.state.recentDirectories]);
    if (recentDirectories.join('\n') === this.state.recentDirectories.join('\n')) return;
    this.commit({ ...this.state, recentDirectories }, 'recentDirectories');
  }

  /** Remembers a closed tab for "reopen closed tab" (most recent first, at most 10). */
  pushClosedTab(tab: TabSpec): void {
    const sanitized = sanitizeTab(tab);
    if (!sanitized) return;
    const closedTabs = [sanitized, ...this.state.closedTabs.filter((entry) => entry.id !== sanitized.id)].slice(0, MAX_CLOSED_TABS);
    this.commit({ ...this.state, closedTabs }, 'closedTabs');
  }

  popClosedTab(): TabSpec | null {
    const [tab, ...closedTabs] = this.state.closedTabs;
    if (!tab) return null;
    this.commit({ ...this.state, closedTabs }, 'closedTabs');
    return tab;
  }

  setFirstRunComplete(): void {
    if (this.state.firstRunComplete) return;
    this.commit({ ...this.state, firstRunComplete: true }, 'firstRunComplete');
  }

  /** Writes pending changes now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.queueSave();
    await this.saving;
  }

  /** Flushes and stops the save timer. */
  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    this.changeListeners.clear();
    this.errorListeners.clear();
  }

  // ---- Buffers ----------------------------------------------------------------

  private bufferPath(paneId: string): string | null {
    return SAFE_PANE_ID.test(paneId) ? join(this.buffersDir, `${paneId}${BUFFER_EXTENSION}`) : null;
  }

  /** Writes one `.vt` file per pane and deletes every other buffer file. */
  async saveBuffers(entries: { paneId: string; data: string }[]): Promise<void> {
    await mkdir(this.buffersDir, { recursive: true });
    const keep = new Set<string>();
    const failures: string[] = [];
    await Promise.all(entries.map(async (entry) => {
      const path = this.bufferPath(entry.paneId);
      if (!path || typeof entry.data !== 'string') return;
      keep.add(`${entry.paneId}${BUFFER_EXTENSION}`.toLowerCase());
      try {
        await writeFileAtomic(path, entry.data, { backup: false });
      } catch (error) {
        failures.push(`${entry.paneId}: ${errorMessage(error)}`);
      }
    }));

    let files: string[] = [];
    try {
      files = await readdir(this.buffersDir);
    } catch {
      files = [];
    }
    await Promise.all(files
      .filter((file) => !keep.has(file.toLowerCase()) && (file.endsWith(BUFFER_EXTENSION) || file.includes(`${BUFFER_EXTENSION}.tmp-`)))
      .map((file) => unlink(join(this.buffersDir, file)).catch(() => undefined)));

    if (failures.length) throw new Error(`Some terminal buffers could not be saved: ${failures.join('; ')}`);
  }

  async readBuffer(paneId: string): Promise<string | null> {
    const path = this.bufferPath(paneId);
    if (!path) return null;
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  async deleteBuffer(paneId: string): Promise<void> {
    const path = this.bufferPath(paneId);
    if (!path) return;
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  // ---- Internals --------------------------------------------------------------

  private commit(state: PersistedState, kind: StateChangeKind): void {
    if (this.disposed) return;
    this.state = state;
    this.dirty = true;
    this.scheduleSave();
    for (const listener of [...this.changeListeners]) {
      try {
        listener({ kind, state });
      } catch {
        // A failing listener must not break persistence.
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.queueSave();
    }, this.saveDelayMs);
  }

  private queueSave(): void {
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const snapshot = this.state;
      try {
        await writeFileAtomic(this.path, `${JSON.stringify(snapshot, null, 2)}\n`);
      } catch (error) {
        this.dirty = true;
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const listener of [...this.errorListeners]) listener(failure);
      }
    });
  }
}
