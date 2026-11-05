// One-way migration of the v1 `lookout-state.json` ({ version: 1, state: { settings,
// roles, presets, projectSpaces } }) into v2 workspaces, a restored window and the
// bits of settings v1 owned. Self-contained on purpose: the v1 types in
// src/types/app.ts are being removed, so only the on-disk shape is described here.

import { win32 } from 'node:path';

import { joinCommandLine } from '../src/shared/commandline';
import { buildGrid, sanitizeLayout } from '../src/shared/layout';
import type { LayoutNode, PaneSpec, TabSpec, WindowSpec, WorkspaceTemplate } from '../src/shared/session';
import type { FontSettings, ProfileDefinition } from '../src/shared/settings';

export interface V1Migration {
  /** One template per v1 project space (id = v1 space id). */
  workspaces: WorkspaceTemplate[];
  /** Open spaces as tabs (pinned first); null when no space was open. */
  window: WindowSpec | null;
  /** v1 terminal font fields, unmodified (first-run decides about Propo faces). */
  font: Partial<FontSettings>;
  recentDirectories: string[];
  /** Profiles created for panes that overrode the shell executable. */
  profiles: ProfileDefinition[];
  /** Every profile id the migrated panes refer to (`pwsh` plus `profiles`). */
  referencedProfileIds: string[];
  /** v1 `restoreOpenProjectSpaces`. */
  restoreSession: boolean;
  warnings: string[];
  stats: {
    spaces: number;
    openSpaces: number;
    pinnedOpenSpaces: number;
    panes: number;
    customTitles: number;
    startupCommands: number;
    presetsSkipped: number;
  };
}

export interface MigrateV1Options {
  newId?: () => string;
  /** ISO timestamp used when v1 dates are missing. */
  now?: () => string;
}

type Obj = Record<string, unknown>;

const V1_DEFAULT_PROFILE_ID = 'pwsh';

/** Columns per v1 layout template id (rows follow from the pane count). */
const TEMPLATE_COLUMNS: Record<string, number> = { 1: 1, 2: 2, 4: 2, 6: 3, 8: 4, 10: 5, 12: 4, 14: 7, 16: 4 };
const TEMPLATE_COUNTS: Record<string, number> = { 1: 1, 2: 2, 4: 4, 6: 6, 8: 8, 10: 10, 12: 12, 14: 14, 16: 16 };

/** v1 built-in roles (display name = default pane title, default startup command). */
const DEFAULT_ROLES: Record<string, { displayName: string; startupCommand?: string }> = {
  'claude-code': { displayName: 'Claude Code', startupCommand: 'claude' },
  codex: { displayName: 'Codex', startupCommand: 'codex' },
  powershell: { displayName: 'PowerShell' },
  build: { displayName: 'Build' },
  git: { displayName: 'Git' },
  test: { displayName: 'Test' },
  logs: { displayName: 'Logs' },
  notes: { displayName: 'Notes' },
};

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObj(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shell';
}

/** Case-insensitive, trailing-separator-insensitive key for Windows paths. */
export function directoryKey(path: string): string {
  const trimmed = path.trim().replace(/\//g, '\\');
  const withoutTrailing = /^[a-z]:\\$/i.test(trimmed) ? trimmed : trimmed.replace(/\\+$/, '');
  return withoutTrailing.toLowerCase();
}

/** Converts the v1 binary tree (`leaf`, `horizontal` = side by side) to the v2 n-ary tree. */
export function convertV1Layout(node: unknown, validPaneIds: Set<string>): LayoutNode | null {
  const convert = (value: unknown, depth: number): unknown => {
    if (!isObj(value) || depth > 64) return null;
    if (value.type === 'leaf') return { type: 'pane', paneId: value.paneId };
    if (value.type !== 'split' || !Array.isArray(value.children)) return null;
    const sizes = Array.isArray(value.sizes) && value.sizes.length === value.children.length ? value.sizes : value.children.map(() => 1);
    return {
      type: 'split',
      direction: value.direction === 'vertical' ? 'column' : 'row',
      children: value.children.map((child) => convert(child, depth + 1)),
      sizes,
    };
  };

  // sanitizeLayout drops unknown panes, collapses single-child splits and flattens
  // same-direction nesting while keeping v1's effective proportions.
  return sanitizeLayout(convert(node, 0), validPaneIds);
}

function listLeafIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : node.children.flatMap(listLeafIds);
}

function remapLayout(node: LayoutNode, map: Map<string, string>): LayoutNode {
  if (node.type === 'pane') return { type: 'pane', paneId: map.get(node.paneId) ?? node.paneId };
  return { ...node, children: node.children.map((child) => remapLayout(child, map)), sizes: [...node.sizes] };
}

interface RoleInfo {
  displayName?: string;
  startupCommand?: string;
  env: Record<string, string>;
}

function readRoles(value: unknown): Map<string, RoleInfo> {
  const roles = new Map<string, RoleInfo>();
  for (const [id, role] of Object.entries(DEFAULT_ROLES)) roles.set(id, { ...role, env: {} });
  if (!Array.isArray(value)) return roles;
  for (const entry of value) {
    if (!isObj(entry) || typeof entry.id !== 'string') continue;
    const builtin = DEFAULT_ROLES[entry.id];
    roles.set(entry.id, {
      displayName: text(entry.displayName) ?? builtin?.displayName,
      // v1 kept `defaultStartupCommand: ''` to mean "none"; a missing value means the built-in default.
      startupCommand: typeof entry.defaultStartupCommand === 'string' ? text(entry.defaultStartupCommand) : builtin?.startupCommand,
      env: stringRecord(entry.envVars),
    });
  }
  return roles;
}

/** Returns null when `raw` is not a v1 state file. Never throws. */
export function migrateV1(raw: unknown, options: MigrateV1Options = {}): V1Migration | null {
  try {
    return migrate(raw, options);
  } catch {
    return null;
  }
}

function migrate(raw: unknown, options: MigrateV1Options): V1Migration | null {
  if (!isObj(raw)) return null;
  if (typeof raw.version === 'number' && raw.version !== 1) return null;
  const state = isObj(raw.state) ? raw.state : raw;
  if (!isObj(state.settings) && !Array.isArray(state.projectSpaces)) return null;

  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const settings = isObj(state.settings) ? state.settings : {};
  const roles = readRoles(state.roles);
  const warnings: string[] = [];
  const stats: V1Migration['stats'] = {
    spaces: 0, openSpaces: 0, pinnedOpenSpaces: 0, panes: 0, customTitles: 0, startupCommands: 0,
    presetsSkipped: Array.isArray(state.presets) ? state.presets.length : 0,
  };

  const profilesByCommand = new Map<string, ProfileDefinition>();
  const profileIds = new Set<string>([V1_DEFAULT_PROFILE_ID]);
  const referenced = new Set<string>();

  const profileFor = (executable: string | undefined, args: string[]): string => {
    if (!executable && !args.length) return V1_DEFAULT_PROFILE_ID;
    // v1 ran `pwsh` (falling back to powershell.exe) when only arguments were overridden.
    const commandline = joinCommandLine([executable ?? 'pwsh.exe', ...args]);
    const key = commandline.toLowerCase();
    const existing = profilesByCommand.get(key);
    if (existing) return existing.id;

    const base = `v1-${slug(win32.basename(executable ?? 'pwsh.exe').replace(/\.exe$/i, ''))}`;
    let id = base;
    for (let index = 2; profileIds.has(id); index += 1) id = `${base}-${index}`;
    profileIds.add(id);
    const profile: ProfileDefinition = { id, name: win32.basename(executable ?? 'pwsh.exe').replace(/\.exe$/i, ''), commandline, source: 'migrated' };
    profilesByCommand.set(key, profile);
    return id;
  };

  const workspaces: WorkspaceTemplate[] = [];
  const openTabs: Array<{ tab: TabSpec; pinned: boolean; spaceId: string }> = [];
  const spaces = Array.isArray(state.projectSpaces) ? state.projectSpaces : [];

  for (const [index, rawSpace] of spaces.entries()) {
    if (!isObj(rawSpace)) {
      warnings.push(`Project space #${index + 1} was not an object and was skipped.`);
      continue;
    }

    const spaceId = text(rawSpace.id) ?? newId();
    const rootPath = text(rawSpace.rootPath);
    const name = text(rawSpace.displayName) ?? (rootPath ? win32.basename(rootPath) || rootPath : 'Workspace');
    const templateId = typeof rawSpace.layoutTemplateId === 'string' && rawSpace.layoutTemplateId in TEMPLATE_COLUMNS ? rawSpace.layoutTemplateId : '4';

    // Panes, with ids made unique within the space.
    const usedPaneIds = new Set<string>();
    const panes: PaneSpec[] = [];
    for (const rawPane of Array.isArray(rawSpace.paneDefinitions) ? rawSpace.paneDefinitions : []) {
      if (!isObj(rawPane)) continue;
      let id = text(rawPane.id) ?? newId();
      if (usedPaneIds.has(id)) id = newId();
      usedPaneIds.add(id);

      const roleId = typeof rawPane.roleId === 'string' ? rawPane.roleId : 'claude-code';
      const role = roles.get(roleId) ?? roles.get('claude-code');
      const executable = text(rawPane.executable);
      const profileId = profileFor(executable, stringList(rawPane.arguments));
      referenced.add(profileId);

      const pane: PaneSpec = { id, profileId };
      const workingDirectory = text(rawPane.workingDirectory);
      if (workingDirectory && (win32.isAbsolute(workingDirectory) || rootPath)) {
        pane.cwd = win32.isAbsolute(workingDirectory) ? win32.normalize(workingDirectory) : win32.resolve(rootPath!, workingDirectory);
      } else if (rootPath) {
        pane.cwd = rootPath;
      }

      // v1: a string (even '') is an explicit choice; anything else means the role default.
      const startupCommand = typeof rawPane.startupCommand === 'string' ? text(rawPane.startupCommand) : role?.startupCommand;
      if (startupCommand) {
        pane.startupCommand = startupCommand;
        stats.startupCommands += 1;
      }

      const title = text(rawPane.title);
      if (title && title !== role?.displayName) {
        pane.title = title;
        stats.customTitles += 1;
      }

      const env = { ...(role?.env ?? {}), ...stringRecord(rawPane.envVars) };
      if (Object.keys(env).length) pane.env = env;
      panes.push(pane);
    }

    if (!panes.length) {
      panes.push({ id: newId(), profileId: V1_DEFAULT_PROFILE_ID, ...(rootPath ? { cwd: rootPath } : {}) });
      referenced.add(V1_DEFAULT_PROFILE_ID);
    }

    let layout = rawSpace.layoutTree ? convertV1Layout(rawSpace.layoutTree, new Set(panes.map((pane) => pane.id))) : null;
    if (rawSpace.layoutTree && !layout) warnings.push(`"${name}": the saved layout was unusable; a grid was used instead.`);
    if (!layout) {
      const ids = panes.slice(0, TEMPLATE_COUNTS[templateId]).map((pane) => pane.id);
      layout = buildGrid(ids, TEMPLATE_COLUMNS[templateId]);
    }

    const shownIds = new Set(listLeafIds(layout));
    const panesById: Record<string, PaneSpec> = {};
    for (const pane of panes) if (shownIds.has(pane.id)) panesById[pane.id] = pane;
    stats.panes += shownIds.size;
    stats.spaces += 1;

    workspaces.push({
      id: spaceId,
      name,
      ...(rootPath ? { rootPath } : {}),
      layout,
      panes: panesById,
      createdAt: text(rawSpace.createdAt) ?? now(),
      updatedAt: text(rawSpace.updatedAt) ?? now(),
    });

    if (rawSpace.isOpen !== false) {
      // Live tabs get fresh pane ids: buffers are keyed by pane id and the template
      // keeps the v1 ids.
      const idMap = new Map([...shownIds].map((paneId) => [paneId, newId()]));
      const tabPanes: Record<string, PaneSpec> = {};
      for (const [oldId, pane] of Object.entries(panesById)) {
        const id = idMap.get(oldId)!;
        tabPanes[id] = { ...structuredClone(pane), id };
      }
      const tabLayout = remapLayout(layout, idMap);
      const pinned = rawSpace.pinned === true;
      openTabs.push({
        pinned,
        spaceId,
        tab: {
          id: newId(),
          // v1 labelled tabs with the space name.
          title: name,
          layout: tabLayout,
          panes: tabPanes,
          focusedPaneId: listLeafIds(tabLayout)[0],
          workspaceId: spaceId,
        },
      });
      stats.openSpaces += 1;
      if (pinned) stats.pinnedOpenSpaces += 1;
    }
  }

  const orderedTabs = [...openTabs.filter((entry) => entry.pinned), ...openTabs.filter((entry) => !entry.pinned)];
  let window: WindowSpec | null = null;
  if (orderedTabs.length) {
    const lastActive = text(settings.lastActiveSpaceId);
    const active = orderedTabs.find((entry) => entry.spaceId === lastActive) ?? orderedTabs[0];
    window = {
      id: newId(),
      kind: 'normal',
      tabs: orderedTabs.map((entry) => entry.tab),
      activeTabId: active.tab.id,
    };

    const windowState = isObj(settings.windowState) ? settings.windowState : {};
    const width = finite(windowState.width);
    const height = finite(windowState.height);
    const x = finite(windowState.x);
    const y = finite(windowState.y);
    if (width !== undefined && height !== undefined && x !== undefined && y !== undefined && width > 0 && height > 0) {
      window.bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    }
    if (typeof windowState.isMaximized === 'boolean') window.maximized = windowState.isMaximized;
  }

  const font: Partial<FontSettings> = {};
  const face = text(settings.terminalFontFace);
  if (face) font.face = face;
  const size = finite(settings.terminalFontSize);
  if (size !== undefined && size > 0) font.size = size;
  const lineHeight = finite(settings.terminalLineHeight);
  if (lineHeight !== undefined && lineHeight > 0) font.lineHeight = lineHeight;
  const letterSpacing = finite(settings.terminalLetterSpacing);
  if (letterSpacing !== undefined) font.letterSpacing = letterSpacing;

  const recentDirectories: string[] = [];
  const seen = new Set<string>();
  for (const entry of stringList(settings.recentProjectPaths)) {
    const directory = entry.trim();
    if (!directory || seen.has(directoryKey(directory))) continue;
    seen.add(directoryKey(directory));
    recentDirectories.push(directory);
  }

  return {
    workspaces,
    window,
    font,
    recentDirectories: recentDirectories.slice(0, 20),
    profiles: [...profilesByCommand.values()],
    referencedProfileIds: [...referenced],
    restoreSession: settings.restoreOpenProjectSpaces !== false,
    warnings,
    stats,
  };
}
