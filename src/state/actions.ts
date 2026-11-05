import { COMMANDS, isCommandId, type CommandId } from '../shared/commands';
import { expandEnvVars } from '../shared/commandline';
import type { LaunchSpec, SessionInfo } from '../shared/host-protocol';
import type { WindowAction } from '../shared/ipc';
import {
  autoSplitEdge,
  buildGrid,
  containsPane,
  equalize,
  findNeighbour,
  listPaneIds,
  movePane as moveInLayout,
  paneLeaf,
  removePane as removeFromLayout,
  resizePane as resizeInLayout,
  setSizesAtPath,
  splitPane as splitLayout,
  swapPanes as swapPanesInLayout,
  type Edge,
} from '../shared/layout';
import type { ProfileDefinition } from '../shared/settings';
import { newId, type LayoutNode, type PaneSpec, type TabSpec, type WindowSpec, type WorkspaceTemplate } from '../shared/session';
import { resolveKeymap, type ResolvedBinding } from '../terminal/keymap';
import { formatDuration, initRuntime, terminals, type CommandRecord } from '../terminal/terminal-manager';
import { getState, patchRuntime, patchUi, pushToast, setState, updateTab, type PaneDropTarget, type PaneRuntime, type TabRuntime } from './store';

// ---------------------------------------------------------------------------
// Profiles & launch specs
// ---------------------------------------------------------------------------

export const HANDOFF_PROFILE_ID = 'handoff';

export function visibleProfiles(): ProfileDefinition[] {
  return getState().settings.profiles.filter((profile) => !profile.hidden);
}

export function findProfile(profileId?: string): ProfileDefinition {
  const { settings } = getState();
  const byId = (id?: string) => (id ? settings.profiles.find((profile) => profile.id === id) : undefined);
  const byName = (name?: string) => (name ? settings.profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase()) : undefined);
  return (
    byId(profileId) ??
    byName(profileId) ??
    byId(settings.defaultProfile) ??
    settings.profiles[0] ?? { id: 'pwsh', name: 'PowerShell', commandline: 'powershell.exe -NoLogo', shellKind: 'powershell' }
  );
}

function expandDirectory(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const home = getState().homeDir;
  // Only home-relative variables are known here; the pty host expands the rest.
  return expandEnvVars(value, { USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2) });
}

export function launchSpecFor(pane: PaneSpec): { launch: LaunchSpec; profile: ProfileDefinition } {
  const profile = findProfile(pane.profileId);
  let commandline = pane.commandline ?? profile.commandline;
  // Like Windows Terminal: a WSL profile starting in "~" means the Linux home, not C:\Users\<you>.
  if (!pane.commandline && !pane.cwd && profile.shellKind === 'wsl' && profile.startingDirectory?.trim() === '~' && !/\s--cd\s/i.test(` ${commandline} `)) {
    commandline = `${commandline} --cd ~`;
  }
  return {
    profile,
    launch: {
      profileId: profile.id,
      commandline,
      startupCommand: pane.startupCommand ?? profile.startupCommand,
      cwd: pane.cwd ?? expandDirectory(profile.startingDirectory) ?? getState().homeDir,
      env: { ...profile.env, ...pane.env },
      shellIntegration: profile.shellIntegration !== false,
    },
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getActiveTab(): TabRuntime | undefined {
  const state = getState();
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

export function getFocusedPaneId(): string | undefined {
  return getActiveTab()?.focusedPaneId;
}

export function tabOfPane(paneId: string): TabRuntime | undefined {
  return getState().tabs.find((tab) => paneId in tab.panes);
}

export function runtimeOf(paneId: string): PaneRuntime | undefined {
  return getState().runtime[paneId];
}

export function isPaneVisible(paneId: string): boolean {
  const tab = getActiveTab();
  if (!tab || !(paneId in tab.panes)) {
    return false;
  }
  return !tab.zoomedPaneId || tab.zoomedPaneId === paneId;
}

/** True when closing the pane would interrupt something the user cares about. */
export function isPaneBusy(paneId: string): boolean {
  const runtime = runtimeOf(paneId);
  if (!runtime || runtime.status === 'exited' || runtime.status === 'error' || !runtime.sessionId) {
    return false;
  }
  if (runtime.commandRunning) {
    return true;
  }
  if (runtime.kind === 'handoff') {
    return true;
  }
  if (runtime.integrated) {
    // cmd has prompt marks but no execution marks: Enter after the prompt means busy.
    return runtime.shellKind === 'cmd' ? runtime.inputSincePrompt : false;
  }
  return runtime.shellKind === 'ssh' || runtime.shellKind === 'wsl' || runtime.shellKind === 'other';
}

function describeBusy(paneIds: string[]): string[] {
  return paneIds
    .filter(isPaneBusy)
    .map((paneId) => {
      const runtime = runtimeOf(paneId);
      return runtime?.currentCommand || runtime?.title || paneTitle(paneId);
    });
}

const EXE_TITLE = /^(?:administrator:\s*)?(?:[a-z]:\\|\\\\)?(?:[^\\/:*?"<>|\r\n]+[\\/])*([^\\/:*?"<>|\r\n]+?)(?:\.exe)?(?:\s+-\s+.*)?$/i;

/** Display title of a pane: user title > program title > folder > profile. */
export function paneTitle(paneId: string): string {
  const tab = tabOfPane(paneId);
  const spec = tab?.panes[paneId];
  if (spec?.title) {
    return spec.title;
  }

  const runtime = runtimeOf(paneId);
  const profile = findProfile(spec?.profileId);
  const rawTitle = runtime?.title?.trim();
  // Titles without a single letter or digit ("\\", "--") say nothing.
  const programTitle = rawTitle && /[\p{L}\p{N}]/u.test(rawTitle) ? rawTitle : undefined;
  if (programTitle) {
    const looksLikeShellPath = /[\\/]/.test(programTitle) && /\.exe\b/i.test(programTitle);
    if (!looksLikeShellPath) {
      return programTitle;
    }
    const match = EXE_TITLE.exec(programTitle);
    const exe = match?.[1]?.toLowerCase();
    const isShell = exe && ['pwsh', 'powershell', 'cmd', 'bash', 'wsl', 'openconsole', 'conhost'].includes(exe);
    // A console Windows handed over has no profile or folder: its program is its name.
    if ((!isShell || runtime?.kind === 'handoff') && match?.[1]) {
      return match[1];
    }
  }

  const cwd = runtime?.cwd ?? spec?.cwd;
  if (cwd) {
    const folder = folderName(cwd, getState().homeDir);
    // In the home folder the folder name says nothing ("~"): name the shell instead.
    if (folder && folder !== '~') {
      return folder;
    }
  }

  return runtime?.kind === 'handoff' ? 'Console' : profile.name;
}

export function folderName(cwd: string, homeDir: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '');
  if (!normalized || !/[^\\/]/.test(normalized)) {
    return '';
  }
  if (homeDir && normalized.toLowerCase() === homeDir.replace(/[\\/]+$/, '').toLowerCase()) {
    return '~';
  }
  return normalized.split(/[\\/]/).pop() || normalized;
}

export function tabTitle(tab: TabRuntime): string {
  return tab.title || paneTitle(tab.focusedPaneId) || 'Terminal';
}

export function shortenPath(cwd: string | undefined, homeDir: string): string {
  if (!cwd) {
    return '';
  }
  if (homeDir && cwd.toLowerCase().startsWith(homeDir.toLowerCase())) {
    return `~${cwd.slice(homeDir.length)}`;
  }
  return cwd;
}

// ---------------------------------------------------------------------------
// Pane lifecycle
// ---------------------------------------------------------------------------

function inheritedCwd(fromPaneId?: string): string | undefined {
  if (!fromPaneId) {
    return undefined;
  }
  const runtime = runtimeOf(fromPaneId);
  const spec = tabOfPane(fromPaneId)?.panes[fromPaneId];
  return runtime?.cwd ?? spec?.cwd;
}

function startPane(spec: PaneSpec, restored = false): void {
  initRuntime(spec.id, 'shell', { cwd: spec.cwd });
  const { launch, profile } = launchSpecFor(spec);
  const restoreBuffer = restored && getState().settings.window.restoreBuffers && getState().restoredPaneIds.has(spec.id);
  void (async () => {
    const buffer = restoreBuffer ? await window.lookout.getRestoredBuffer(spec.id) : null;
    await terminals.start(spec.id, launch, profile, buffer);
  })();
}

/** Brings up a restored tab: adopts live sessions (renderer reload) or starts fresh shells. */
export async function hydrateTab(tab: TabRuntime, liveSessions: Map<string, SessionInfo>): Promise<void> {
  for (const spec of Object.values(tab.panes)) {
    const live = liveSessions.get(spec.id);
    if (live) {
      initRuntime(spec.id, live.kind, { cwd: spec.cwd ?? live.cwd });
      const ok = await terminals.adopt(spec.id, live.sessionId, findProfile(spec.profileId));
      if (ok) {
        continue;
      }
    }
    startPane(spec, true);
  }
}

export interface NewPaneOptions {
  profileId?: string;
  cwd?: string;
  title?: string;
  commandline?: string;
  startupCommand?: string;
  /** Pane to inherit cwd from (splits/new tabs). */
  inheritFrom?: string;
}

function makePaneSpec(options: NewPaneOptions): PaneSpec {
  const profile = findProfile(options.profileId);
  const inherit = getState().settings.window.newTabDirectory === 'inherit' || Boolean(options.inheritFrom);
  const cwd = options.cwd ?? (inherit && options.inheritFrom ? inheritedCwd(options.inheritFrom) : undefined);
  return {
    id: newId(),
    profileId: profile.id,
    cwd: cwd ?? undefined,
    title: options.title,
    commandline: options.commandline,
    startupCommand: options.startupCommand,
  };
}

export function newTab(options: NewPaneOptions & { tabColor?: string; activate?: boolean } = {}): string {
  const profile = findProfile(options.profileId);
  if (profile.elevate && !getState().elevated) {
    window.lookout.openAdminWindow([{ type: 'new-tab', profileId: profile.id, cwd: options.cwd }]);
    return '';
  }

  const inheritFrom =
    options.inheritFrom ?? (getState().settings.window.newTabDirectory === 'inherit' && !options.cwd ? getFocusedPaneId() : undefined);
  const spec = makePaneSpec({ ...options, inheritFrom });
  const tab: TabRuntime = {
    id: newId(),
    color: options.tabColor ?? profile.tabColor,
    layout: paneLeaf(spec.id),
    panes: { [spec.id]: spec },
    focusedPaneId: spec.id,
    zoomedPaneId: null,
    broadcast: false,
  };

  setState((state) => {
    const activeIndex = state.tabs.findIndex((entry) => entry.id === state.activeTabId);
    const tabs = [...state.tabs];
    tabs.splice(activeIndex >= 0 ? activeIndex + 1 : tabs.length, 0, tab);
    return { tabs, activeTabId: options.activate === false ? state.activeTabId : tab.id };
  });
  startPane(spec);
  focusPaneSoon(spec.id);
  return tab.id;
}

export function splitPane(edge: Edge | 'auto', options: NewPaneOptions & { size?: number; paneId?: string } = {}): void {
  const tab = options.paneId ? tabOfPane(options.paneId) : getActiveTab();
  if (!tab) {
    newTab(options);
    return;
  }

  const targetId = options.paneId ?? tab.focusedPaneId;
  const targetSpec = tab.panes[targetId];
  let resolvedEdge: Edge = edge === 'auto' ? 'right' : edge;
  if (edge === 'auto') {
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${targetId}"]`);
    resolvedEdge = element ? autoSplitEdge(element.clientWidth, element.clientHeight) : 'right';
  }

  const spec = makePaneSpec({
    ...options,
    profileId: options.profileId ?? targetSpec?.profileId,
    inheritFrom: targetId,
  });
  if (!options.profileId && targetSpec) {
    spec.startupCommand = undefined;
  }

  updateTab(tab.id, (current) => ({
    ...current,
    layout: splitLayout(current.layout, targetId, spec.id, resolvedEdge, options.size ? 1 - options.size : 0.5),
    panes: { ...current.panes, [spec.id]: spec },
    focusedPaneId: spec.id,
    zoomedPaneId: null,
  }));
  startPane(spec);
  focusPaneSoon(spec.id);
}

export function focusPane(paneId: string): void {
  const tab = tabOfPane(paneId);
  if (!tab) {
    return;
  }
  setState((state) => ({
    activeTabId: tab.id,
    tabs: state.tabs.map((entry) => (entry.id === tab.id ? { ...entry, focusedPaneId: paneId } : entry)),
  }));
  patchRuntime(paneId, { activity: false, bell: false });
  focusPaneSoon(paneId);
}

export function focusPaneSoon(paneId: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(paneId)));
}

export function activateTab(tabId: string): void {
  const tab = getState().tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    return;
  }
  setState({ activeTabId: tabId });
  for (const paneId of Object.keys(tab.panes)) {
    patchRuntime(paneId, { activity: false, bell: false });
  }
  focusPaneSoon(tab.focusedPaneId);
}

function confirmIfBusy(paneIds: string[], title: string, confirmLabel: string, proceed: () => void): void {
  const busy = describeBusy(paneIds);
  if (!busy.length || !getState().settings.window.confirmCloseRunning) {
    proceed();
    return;
  }

  patchUi({
    dialog: {
      kind: 'confirm',
      title,
      message: busy.length === 1 ? 'This is still running:' : `${busy.length} things are still running:`,
      detail: busy.slice(0, 6),
      confirmLabel,
      danger: true,
      onConfirm: proceed,
    },
  });
}

/** Removes a pane from its tab, killing its session. */
function dropPane(paneId: string, killSession = true): void {
  const tab = tabOfPane(paneId);
  if (!tab) {
    return;
  }

  const layout = removeFromLayout(tab.layout, paneId);
  terminals.destroy(paneId, killSession);
  setState((state) => {
    const runtime = { ...state.runtime };
    delete runtime[paneId];
    if (!layout) {
      return { runtime };
    }
    const panes = { ...tab.panes };
    delete panes[paneId];
    const remaining = listPaneIds(layout);
    return {
      runtime,
      tabs: state.tabs.map((entry) =>
        entry.id === tab.id
          ? {
              ...entry,
              layout,
              panes,
              focusedPaneId: entry.focusedPaneId === paneId ? nearestPane(tab.layout, paneId, remaining) : entry.focusedPaneId,
              zoomedPaneId: entry.zoomedPaneId === paneId ? null : entry.zoomedPaneId,
            }
          : entry,
      ),
    };
  });

  if (!layout) {
    removeTab(tab.id);
  } else if (getState().activeTabId === tab.id) {
    const focused = getState().tabs.find((entry) => entry.id === tab.id)?.focusedPaneId;
    if (focused) {
      focusPaneSoon(focused);
    }
  }
}

function nearestPane(layout: LayoutNode, paneId: string, remaining: string[]): string {
  for (const edge of ['left', 'up', 'right', 'down'] as Edge[]) {
    const neighbour = findNeighbour(layout, paneId, edge);
    if (neighbour && remaining.includes(neighbour)) {
      return neighbour;
    }
  }
  return remaining[0];
}

function removeTab(tabId: string): void {
  setState((state) => {
    const index = state.tabs.findIndex((tab) => tab.id === tabId);
    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId = state.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeTabId;
    return { tabs, activeTabId };
  });

  const state = getState();
  if (!state.tabs.length) {
    if (state.windowKind === 'quake') {
      newTab();
    } else {
      window.lookout.closeConfirmed();
    }
    return;
  }
  const active = getActiveTab();
  if (active) {
    focusPaneSoon(active.focusedPaneId);
  }
}

export function closePane(paneId?: string, options: { force?: boolean } = {}): void {
  const target = paneId ?? getFocusedPaneId();
  if (!target) {
    return;
  }
  if (options.force) {
    dropPane(target);
    return;
  }
  confirmIfBusy([target], 'Close this pane?', 'Close pane', () => dropPane(target));
}

export function closeTab(tabId?: string): void {
  const tab = tabId ? getState().tabs.find((entry) => entry.id === tabId) : getActiveTab();
  if (!tab) {
    return;
  }
  confirmIfBusy(Object.keys(tab.panes), 'Close this tab?', 'Close tab', () => {
    window.lookout.pushClosedTab(snapshotTab(tab));
    for (const paneId of Object.keys(tab.panes)) {
      terminals.destroy(paneId, true);
    }
    setState((state) => {
      const runtime = { ...state.runtime };
      Object.keys(tab.panes).forEach((paneId) => delete runtime[paneId]);
      return { runtime };
    });
    removeTab(tab.id);
  });
}

export function closeOtherTabs(tabId?: string): void {
  const keep = tabId ?? getState().activeTabId;
  const others = getState().tabs.filter((tab) => tab.id !== keep);
  confirmIfBusy(
    others.flatMap((tab) => Object.keys(tab.panes)),
    `Close ${others.length} other tab${others.length === 1 ? '' : 's'}?`,
    'Close tabs',
    () => {
      for (const tab of others) {
        window.lookout.pushClosedTab(snapshotTab(tab));
        Object.keys(tab.panes).forEach((paneId) => terminals.destroy(paneId, true));
      }
      setState((state) => {
        const runtime = { ...state.runtime };
        others.forEach((tab) => Object.keys(tab.panes).forEach((paneId) => delete runtime[paneId]));
        return { runtime, tabs: state.tabs.filter((tab) => tab.id === keep), activeTabId: keep };
      });
    },
  );
}

export function requestWindowClose(): void {
  const paneIds = getState().tabs.flatMap((tab) => Object.keys(tab.panes));
  confirmIfBusy(paneIds, 'Close this window?', 'Close window', () => window.lookout.closeConfirmed());
}

export function restartPane(paneId?: string): void {
  const target = paneId ?? getFocusedPaneId();
  const tab = target ? tabOfPane(target) : undefined;
  if (!target || !tab) {
    return;
  }
  const spec = { ...tab.panes[target], cwd: runtimeOf(target)?.cwd ?? tab.panes[target].cwd };
  if (runtimeOf(target)?.kind === 'handoff') {
    return;
  }
  const { launch, profile } = launchSpecFor(spec);
  patchRuntime(target, { lastCommand: undefined, restored: false });
  void terminals.restart(target, launch, profile);
}

export function moveFocus(edge: Edge): void {
  const tab = getActiveTab();
  if (!tab || tab.zoomedPaneId) {
    return;
  }
  const neighbour = findNeighbour(tab.layout, tab.focusedPaneId, edge);
  if (neighbour) {
    focusPane(neighbour);
  }
}

export function cyclePane(direction: 1 | -1): void {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  const ids = listPaneIds(tab.layout);
  const index = ids.indexOf(tab.focusedPaneId);
  const next = ids[(index + direction + ids.length) % ids.length];
  if (next) {
    focusPane(next);
  }
}

export function resizeFocused(edge: Edge): void {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }
  updateTab(tab.id, (current) => ({ ...current, layout: resizeInLayout(current.layout, current.focusedPaneId, edge, 0.04) }));
}

export function setSplitSizes(tabId: string, path: number[], sizes: number[]): void {
  updateTab(tabId, (current) => ({ ...current, layout: setSizesAtPath(current.layout, path, sizes) }));
}

export function equalizeTab(tabId?: string): void {
  const tab = tabId ? getState().tabs.find((entry) => entry.id === tabId) : getActiveTab();
  if (tab) {
    updateTab(tab.id, (current) => ({ ...current, layout: equalize(current.layout) }));
  }
}

export function toggleZoom(paneId?: string): void {
  const tab = paneId ? tabOfPane(paneId) : getActiveTab();
  if (!tab || Object.keys(tab.panes).length < 2) {
    return;
  }
  const target = paneId ?? tab.focusedPaneId;
  updateTab(tab.id, (current) => ({ ...current, zoomedPaneId: current.zoomedPaneId ? null : target, focusedPaneId: target }));
  focusPaneSoon(target);
}

export function toggleBroadcast(tabId?: string): void {
  const tab = tabId ? getState().tabs.find((entry) => entry.id === tabId) : getActiveTab();
  if (!tab) {
    return;
  }
  updateTab(tab.id, (current) => ({ ...current, broadcast: !current.broadcast }));
  pushToast({ tone: 'info', title: tab.broadcast ? 'Broadcast off' : 'Broadcasting input to every pane in this tab', timeoutMs: 2500 });
}

export function broadcastTargets(paneId: string): string[] {
  const tab = tabOfPane(paneId);
  if (!tab?.broadcast) {
    return [];
  }
  return Object.keys(tab.panes).filter((id) => id !== paneId);
}

/** Drag & drop of a pane onto another pane's edge (same or different tab). */
export function dropPaneOn(paneId: string, targetPaneId: string, edge: Edge | 'center'): void {
  if (paneId === targetPaneId) {
    return;
  }
  const source = tabOfPane(paneId);
  const target = tabOfPane(targetPaneId);
  if (!source || !target) {
    return;
  }

  if (source.id === target.id) {
    updateTab(source.id, (current) => ({
      ...current,
      // Center = swap places; an edge = dock next to the target.
      layout: edge === 'center' ? swapPanesInLayout(current.layout, paneId, targetPaneId) : moveInLayout(current.layout, paneId, targetPaneId, edge),
      focusedPaneId: paneId,
    }));
    focusPaneSoon(paneId);
    return;
  }

  movePaneToTab(paneId, target.id, targetPaneId, edge === 'center' ? 'right' : edge);
}

export function movePaneToTab(paneId: string, targetTabId: string, anchorPaneId?: string, edge: Edge = 'right'): void {
  const source = tabOfPane(paneId);
  const target = getState().tabs.find((tab) => tab.id === targetTabId);
  if (!source || !target || source.id === target.id) {
    return;
  }

  const spec = source.panes[paneId];
  const sourceLayout = removeFromLayout(source.layout, paneId);
  const anchor = anchorPaneId && containsPane(target.layout, anchorPaneId) ? anchorPaneId : target.focusedPaneId;

  setState((state) => {
    let tabs = state.tabs.map((tab) => {
      if (tab.id === target.id) {
        return { ...tab, layout: splitLayout(tab.layout, anchor, paneId, edge), panes: { ...tab.panes, [paneId]: spec }, focusedPaneId: paneId, zoomedPaneId: null };
      }
      if (tab.id === source.id && sourceLayout) {
        const panes = { ...tab.panes };
        delete panes[paneId];
        return { ...tab, layout: sourceLayout, panes, focusedPaneId: tab.focusedPaneId === paneId ? listPaneIds(sourceLayout)[0] : tab.focusedPaneId };
      }
      return tab;
    });
    if (!sourceLayout) {
      tabs = tabs.filter((tab) => tab.id !== source.id);
    }
    return { tabs, activeTabId: target.id };
  });
  focusPaneSoon(paneId);
}

export function movePaneToNewTab(paneId?: string): string | null {
  const target = paneId ?? getFocusedPaneId();
  const source = target ? tabOfPane(target) : undefined;
  if (!target || !source || Object.keys(source.panes).length < 2) {
    return null;
  }

  const spec = source.panes[target];
  const layout = removeFromLayout(source.layout, target);
  if (!layout) {
    return null;
  }
  const tab: TabRuntime = { id: newId(), layout: paneLeaf(target), panes: { [target]: spec }, focusedPaneId: target, zoomedPaneId: null, broadcast: false };

  setState((state) => {
    const panes = { ...source.panes };
    delete panes[target];
    const tabs = state.tabs.map((entry) =>
      entry.id === source.id ? { ...entry, layout, panes, focusedPaneId: entry.focusedPaneId === target ? listPaneIds(layout)[0] : entry.focusedPaneId } : entry,
    );
    const index = tabs.findIndex((entry) => entry.id === source.id);
    tabs.splice(index + 1, 0, tab);
    return { tabs, activeTabId: tab.id };
  });
  focusPaneSoon(target);
  return tab.id;
}

/** Gives a pane its own window (a single-pane tab travels as a whole). */
export function movePaneToNewWindow(paneId: string, screenPoint?: { x: number; y: number }): void {
  const tab = tabOfPane(paneId);
  if (!tab) {
    return;
  }
  const tabId = Object.keys(tab.panes).length > 1 ? movePaneToNewTab(paneId) : tab.id;
  if (tabId) {
    moveTabToNewWindow(tabId, screenPoint);
  }
}

/** Applies a pointer drag of a pane (see PaneDropTarget). */
export function applyPaneDrop(paneId: string, target: PaneDropTarget, screenPoint?: { x: number; y: number }): void {
  switch (target.kind) {
    case 'pane':
      dropPaneOn(paneId, target.paneId, target.zone);
      return;
    case 'tab': {
      const source = tabOfPane(paneId);
      if (source?.id === target.tabId) {
        return;
      }
      // A lone pane dragged onto another tab merges into it (its own tab disappears).
      movePaneToTab(paneId, target.tabId);
      return;
    }
    case 'newTab':
      movePaneToNewTab(paneId);
      return;
    case 'newWindow':
      movePaneToNewWindow(paneId, screenPoint);
      return;
  }
}

export function reorderTab(tabId: string, beforeTabId: string | null): void {
  setState((state) => {
    const tab = state.tabs.find((entry) => entry.id === tabId);
    if (!tab || tabId === beforeTabId) {
      return state;
    }
    const tabs = state.tabs.filter((entry) => entry.id !== tabId);
    const index = beforeTabId ? tabs.findIndex((entry) => entry.id === beforeTabId) : tabs.length;
    tabs.splice(index < 0 ? tabs.length : index, 0, tab);
    return { tabs };
  });
}

/** Sends a tab (with its live sessions) to a brand-new window. */
export function moveTabToNewWindow(tabId?: string, screenPoint?: { x: number; y: number }): void {
  const tab = tabId ? getState().tabs.find((entry) => entry.id === tabId) : getActiveTab();
  if (!tab) {
    return;
  }
  if (getState().tabs.length === 1 && !screenPoint) {
    return;
  }

  const sessions: Record<string, string> = {};
  for (const paneId of Object.keys(tab.panes)) {
    const sessionId = terminals.sessionIdOf(paneId);
    if (sessionId) {
      sessions[paneId] = sessionId;
    }
  }
  const spec = snapshotTab(tab);
  for (const paneId of Object.keys(tab.panes)) {
    terminals.destroy(paneId, false);
  }
  setState((state) => {
    const runtime = { ...state.runtime };
    Object.keys(tab.panes).forEach((paneId) => delete runtime[paneId]);
    return { runtime };
  });
  window.lookout.moveTabToNewWindow(spec, sessions, screenPoint);
  removeTab(tab.id);
}

export async function adoptTab(spec: TabSpec, sessions: Record<string, string>): Promise<void> {
  const tab: TabRuntime = { ...spec, zoomedPaneId: null, broadcast: false };
  setState((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  for (const pane of Object.values(tab.panes)) {
    const sessionId = sessions[pane.id];
    initRuntime(pane.id, 'shell', { cwd: pane.cwd });
    const ok = sessionId ? await terminals.adopt(pane.id, sessionId, findProfile(pane.profileId)) : false;
    if (!ok) {
      startPane(pane);
    }
  }
  focusPaneSoon(tab.focusedPaneId);
}

/** A console Windows handed to Lookout (default terminal). */
export async function adoptHandoff(session: SessionInfo): Promise<void> {
  // The handoff ABI carries no working directory; never show a fake one.
  const cwd = session.cwd && /^[a-z]:\\/i.test(session.cwd) ? session.cwd : undefined;
  const spec: PaneSpec = { id: newId(), profileId: HANDOFF_PROFILE_ID, cwd };
  const tab: TabRuntime = { id: newId(), layout: paneLeaf(spec.id), panes: { [spec.id]: spec }, focusedPaneId: spec.id, zoomedPaneId: null, broadcast: false };
  initRuntime(spec.id, 'handoff', { title: session.title, cwd });
  setState((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  const ok = await terminals.adopt(spec.id, session.sessionId);
  if (!ok) {
    dropPane(spec.id, false);
    return;
  }
  focusPaneSoon(spec.id);
}

export function renameTab(tabId: string, title: string): void {
  updateTab(tabId, (tab) => ({ ...tab, title: title.trim() || undefined }));
}

export function setTabColor(tabId: string, color: string | undefined): void {
  updateTab(tabId, (tab) => ({ ...tab, color }));
}

export function renamePane(paneId: string, title: string): void {
  const tab = tabOfPane(paneId);
  if (!tab) {
    return;
  }
  updateTab(tab.id, (current) => ({ ...current, panes: { ...current.panes, [paneId]: { ...current.panes[paneId], title: title.trim() || undefined } } }));
}

export function duplicateTab(tabId?: string): void {
  const tab = tabId ? getState().tabs.find((entry) => entry.id === tabId) : getActiveTab();
  if (!tab) {
    return;
  }
  openTabFromTemplate(snapshotTab(tab), undefined, tab.color);
}

function openTabFromTemplate(template: { layout: LayoutNode; panes: Record<string, PaneSpec>; focusedPaneId?: string }, workspaceId?: string, color?: string, title?: string): string {
  const idMap = new Map<string, string>();
  const panes: Record<string, PaneSpec> = {};
  for (const [oldId, spec] of Object.entries(template.panes)) {
    const id = newId();
    idMap.set(oldId, id);
    panes[id] = { ...spec, id };
  }
  const remap = (node: LayoutNode): LayoutNode =>
    node.type === 'pane' ? paneLeaf(idMap.get(node.paneId) ?? node.paneId) : { ...node, children: node.children.map(remap) };
  const layout = remap(template.layout);
  const focused = (template.focusedPaneId && idMap.get(template.focusedPaneId)) ?? listPaneIds(layout)[0];
  const tab: TabRuntime = { id: newId(), title, color, layout, panes, focusedPaneId: focused, workspaceId, zoomedPaneId: null, broadcast: false };

  setState((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  Object.values(panes).forEach((spec) => startPane(spec));
  focusPaneSoon(focused);
  return tab.id;
}

export async function reopenClosedTab(): Promise<void> {
  const spec = await window.lookout.popClosedTab();
  if (!spec) {
    pushToast({ tone: 'info', title: 'No recently closed tabs', timeoutMs: 2000 });
    return;
  }
  openTabFromTemplate(spec, spec.workspaceId, spec.color, spec.title);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function saveTabAsWorkspace(tabId?: string, name?: string): void {
  const tab = tabId ? getState().tabs.find((entry) => entry.id === tabId) : getActiveTab();
  if (!tab) {
    return;
  }

  const save = (workspaceName: string) => {
    const snapshot = snapshotTab(tab);
    const existing = tab.workspaceId ? getState().workspaces.find((workspace) => workspace.id === tab.workspaceId) : undefined;
    const now = new Date().toISOString();
    const workspace: WorkspaceTemplate = {
      id: existing?.id ?? newId(),
      name: workspaceName.trim() || tabTitle(tab),
      rootPath: runtimeOf(tab.focusedPaneId)?.cwd ?? Object.values(tab.panes)[0]?.cwd,
      layout: snapshot.layout,
      panes: snapshot.panes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing?.elevate) {
      workspace.elevate = true;
    }
    window.lookout.saveWorkspace(workspace);
    updateTab(tab.id, (current) => ({ ...current, workspaceId: workspace.id }));
    pushToast({ tone: 'success', title: `Saved workspace “${workspace.name}”`, timeoutMs: 2500 });
  };

  if (name) {
    save(name);
    return;
  }

  patchUi({
    dialog: {
      kind: 'prompt',
      title: tab.workspaceId ? 'Update workspace' : 'Save as workspace',
      label: 'Workspace name',
      initial: getState().workspaces.find((workspace) => workspace.id === tab.workspaceId)?.name ?? tabTitle(tab),
      confirmLabel: 'Save',
      onSubmit: save,
    },
  });
}

export function openWorkspace(nameOrId: string): void {
  const { workspaces, tabs } = getState();
  const lower = nameOrId.toLowerCase();
  const workspace = workspaces.find((entry) => entry.id === nameOrId) ?? workspaces.find((entry) => entry.name.toLowerCase() === lower);
  if (!workspace) {
    pushToast({ tone: 'error', title: `No workspace named “${nameOrId}”` });
    return;
  }
  if (workspace.elevate && !getState().elevated) {
    // The administrator window copies it from our saved state and opens it after UAC.
    window.lookout.openAdminWindow([{ type: 'open-workspace', nameOrId: workspace.id }]);
    return;
  }

  const open = tabs.find((tab) => tab.workspaceId === workspace.id);
  if (open) {
    activateTab(open.id);
    return;
  }
  openTabFromTemplate(workspace, workspace.id, undefined, workspace.name);
}

/** Workspaces marked "Run as administrator" open in the administrator window, after a UAC prompt. */
export function setWorkspaceElevated(id: string, elevate: boolean): void {
  const workspace = getState().workspaces.find((entry) => entry.id === id);
  if (!workspace || Boolean(workspace.elevate) === elevate) {
    return;
  }
  const next: WorkspaceTemplate = { ...workspace };
  if (elevate) {
    next.elevate = true;
  } else {
    delete next.elevate;
  }
  window.lookout.saveWorkspace(next);
  const open = getState().tabs.some((tab) => tab.workspaceId === id);
  pushToast({
    tone: 'success',
    title: elevate ? `“${workspace.name}” now opens as administrator` : `“${workspace.name}” opens in this window again`,
    body: elevate && open ? 'The tab that is open now stays as it is.' : undefined,
    timeoutMs: 3500,
  });
}

export function deleteWorkspace(id: string): void {
  window.lookout.deleteWorkspace(id);
  setState((state) => ({ tabs: state.tabs.map((tab) => (tab.workspaceId === id ? { ...tab, workspaceId: undefined } : tab)) }));
}

/** Template for a grid workspace (used by the palette's "New grid…" entries). */
export function newGridTab(count: number, columns: number, profileId?: string): void {
  const specs = Array.from({ length: count }, () => makePaneSpec({ profileId, inheritFrom: getFocusedPaneId() }));
  const layout = buildGrid(
    specs.map((spec) => spec.id),
    columns,
  );
  const tab: TabRuntime = {
    id: newId(),
    layout,
    panes: Object.fromEntries(specs.map((spec) => [spec.id, spec])),
    focusedPaneId: specs[0].id,
    zoomedPaneId: null,
    broadcast: false,
  };
  setState((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  specs.forEach((spec) => startPane(spec));
  focusPaneSoon(specs[0].id);
}

// ---------------------------------------------------------------------------
// Snapshots for persistence / transfer
// ---------------------------------------------------------------------------

export function snapshotTab(tab: TabRuntime): TabSpec {
  const panes: Record<string, PaneSpec> = {};
  for (const [paneId, spec] of Object.entries(tab.panes)) {
    const runtime = runtimeOf(paneId);
    panes[paneId] = { ...spec, cwd: runtime?.cwd ?? spec.cwd };
  }
  return {
    id: tab.id,
    title: tab.title,
    color: tab.color,
    layout: tab.layout,
    panes,
    focusedPaneId: tab.focusedPaneId,
    workspaceId: tab.workspaceId,
  };
}

export function snapshotWindow(): WindowSpec {
  const state = getState();
  return {
    id: state.windowId,
    kind: state.windowKind,
    tabs: state.tabs.filter((tab) => !Object.values(tab.panes).some((pane) => pane.profileId === HANDOFF_PROFILE_ID)).map(snapshotTab),
    activeTabId: state.activeTabId,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth,
  };
}

// ---------------------------------------------------------------------------
// Window actions from main (CLI, tray, notifications, transfers)
// ---------------------------------------------------------------------------

export function handleWindowAction(action: WindowAction): void {
  switch (action.type) {
    case 'new-tab':
      newTab({ profileId: action.profileId, cwd: action.cwd, title: action.title, tabColor: action.tabColor, commandline: action.commandline });
      return;
    case 'split-pane':
      splitPane(action.direction === 'auto' ? 'auto' : action.direction, {
        profileId: action.profileId,
        cwd: action.cwd,
        title: action.title,
        commandline: action.commandline,
        size: action.size,
      });
      return;
    case 'focus-tab': {
      const tab = getState().tabs[action.index];
      if (tab) {
        activateTab(tab.id);
      }
      return;
    }
    case 'open-workspace':
      openWorkspace(action.nameOrId);
      return;
    case 'open-settings':
      patchUi({ settingsOpen: true, settingsSection: action.section ?? getState().ui.settingsSection });
      return;
    case 'adopt-session':
      void adoptHandoff(action.session);
      return;
    case 'adopt-tab':
      void adoptTab(action.tab, action.sessions);
      return;
    case 'focus-pane':
      focusPane(action.paneId);
      return;
    case 'command':
      runCommand(action.command, action.args);
      return;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

let keymapCache: { source: unknown; map: Map<string, ResolvedBinding> } | null = null;

export function getKeymap(): Map<string, ResolvedBinding> {
  const bindings = getState().settings.keybindings;
  if (!keymapCache || keymapCache.source !== bindings) {
    keymapCache = { source: bindings, map: resolveKeymap(bindings, isCommandId) };
  }
  return keymapCache.map;
}

export function confirmPaste(paneId: string, text: string, reason: 'multiline' | 'large' | 'both'): Promise<string | null> {
  return new Promise((resolve) => {
    patchUi({
      dialog: {
        kind: 'paste',
        paneId,
        text,
        reason,
        onConfirm: (value) => resolve(value),
      },
    });
    // The dialog component resolves null on cancel via the same callback contract.
    pendingPasteResolvers.set(paneId, resolve);
  });
}

export const pendingPasteResolvers = new Map<string, (value: string | null) => void>();

export function commandFinished(paneId: string, record: CommandRecord): void {
  const { settings, flags } = getState();
  const cwd = runtimeOf(paneId)?.cwd;
  if (cwd && settings.gitStatus) {
    window.lookout.gitRefresh(cwd);
  }

  if (!settings.notifications.enabled || !record.startedAt || !record.endedAt) {
    return;
  }
  const duration = record.endedAt - record.startedAt;
  if (duration < settings.notifications.longCommandSeconds * 1000) {
    return;
  }
  const away = !flags.focused || !isPaneVisible(paneId);
  if (settings.notifications.onlyWhenUnfocused && !away) {
    return;
  }

  const tab = tabOfPane(paneId);
  const failed = record.exitCode !== undefined && record.exitCode !== 0;
  const command = record.command?.trim() || 'Command';
  window.lookout.notify({
    title: `${failed ? '✗' : '✓'} ${command.length > 60 ? `${command.slice(0, 57)}…` : command}`,
    body: `${failed ? `Failed with exit code ${record.exitCode}` : 'Finished'} after ${formatDuration(duration)} · ${tab ? tabTitle(tab) : ''}`,
    tabId: tab?.id ?? '',
    paneId,
  });
  if (away) {
    patchRuntime(paneId, { bell: true });
  }
}

export function paneNotification(paneId: string, title: string, body: string): void {
  const tab = tabOfPane(paneId);
  const { flags } = getState();
  if (flags.focused && isPaneVisible(paneId)) {
    pushToast({ tone: 'info', title, body, timeoutMs: 4000 });
    return;
  }
  window.lookout.notify({ title, body, tabId: tab?.id ?? '', paneId });
}

type Args = Record<string, string | number | boolean> | undefined;

/** Runs a command. Returns false when it did nothing, so the key can reach the shell. */
export function runCommand(command: CommandId, args?: Args): boolean {
  const paneId = getFocusedPaneId();
  const state = getState();

  switch (command) {
    case 'newTab':
      newTab({ profileId: typeof args?.profile === 'string' ? args.profile : undefined });
      return true;
    case 'newTabProfileIndex': {
      const profile = visibleProfiles()[Number(args?.index ?? 0)];
      if (!profile) {
        return false;
      }
      newTab({ profileId: profile.id });
      return true;
    }
    case 'newTabMenu':
      patchUi({ palette: { mode: 'profiles', query: '' } });
      return true;
    case 'duplicateTab':
      duplicateTab();
      return true;
    case 'closeTab':
      closeTab();
      return true;
    case 'closeOtherTabs':
      closeOtherTabs();
      return true;
    case 'reopenClosedTab':
      void reopenClosedTab();
      return true;
    case 'nextTab':
    case 'prevTab': {
      const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const delta = command === 'nextTab' ? 1 : -1;
      const next = state.tabs[(index + delta + state.tabs.length) % state.tabs.length];
      if (next) {
        activateTab(next.id);
      }
      return true;
    }
    case 'switchToTab': {
      const index = Number(args?.index ?? 0);
      const tab = index < 0 ? state.tabs.at(-1) : state.tabs[index];
      if (tab) {
        activateTab(tab.id);
      }
      return true;
    }
    case 'renameTab':
      if (state.activeTabId) {
        patchUi({ renamingTabId: state.activeTabId });
      }
      return true;
    case 'moveTabToNewWindow':
      moveTabToNewWindow();
      return true;
    case 'newWindow':
      window.lookout.newWindow();
      return true;
    case 'openAdminWindow':
      window.lookout.openAdminWindow();
      return true;
    case 'toggleSidebar':
      setState((current) => ({ sidebarCollapsed: !current.sidebarCollapsed }));
      return true;
    case 'toggleFullscreen':
      window.lookout.setFullscreen();
      return true;
    case 'toggleQuake':
      window.lookout.toggleQuake();
      return true;
    case 'commandPalette':
      patchUi({ palette: state.ui.palette ? null : { mode: 'commands', query: '' } });
      return true;
    case 'openSettings':
      patchUi({ settingsOpen: !state.ui.settingsOpen });
      return true;
    case 'openSettingsJson':
      window.lookout.openSettingsFile();
      return true;
    case 'toggleDevTools':
      window.lookout.toggleDevTools();
      return true;
    case 'quit':
      window.lookout.quit();
      return true;

    case 'splitRight':
      splitPane('right', { profileId: typeof args?.profile === 'string' ? args.profile : undefined });
      return true;
    case 'splitDown':
      splitPane('down', { profileId: typeof args?.profile === 'string' ? args.profile : undefined });
      return true;
    case 'splitAuto':
      splitPane('auto');
      return true;
    case 'closePane':
      closePane();
      return true;
    case 'focusPane':
      moveFocus((args?.direction as Edge) ?? 'right');
      return true;
    case 'focusNextPane':
      cyclePane(1);
      return true;
    case 'focusPrevPane':
      cyclePane(-1);
      return true;
    case 'resizePane':
      resizeFocused((args?.direction as Edge) ?? 'right');
      return true;
    case 'equalizePanes':
      equalizeTab();
      return true;
    case 'togglePaneZoom':
      toggleZoom();
      return true;
    case 'movePaneToNewTab':
      movePaneToNewTab();
      return true;
    case 'restartPane':
      restartPane();
      return true;
    case 'toggleBroadcast':
      toggleBroadcast();
      return true;
  }

  if (!paneId) {
    return false;
  }

  switch (command) {
    case 'copy':
      if (!terminals.hasSelection(paneId)) {
        return false;
      }
      void terminals.copySelection(paneId);
      return true;
    case 'paste':
      void terminals.paste(paneId);
      return true;
    case 'selectAll':
      terminals.selectAll(paneId);
      return true;
    case 'find':
      patchUi({ findPaneId: paneId });
      return true;
    case 'findNext':
    case 'findPrev':
      if (state.ui.findPaneId !== paneId) {
        return false;
      }
      window.dispatchEvent(new CustomEvent('lookout:find-step', { detail: command === 'findNext' ? 1 : -1 }));
      return true;
    case 'clearBuffer':
      terminals.clear(paneId);
      return true;
    case 'scrollUp':
      terminals.scroll(paneId, 'lineUp');
      return true;
    case 'scrollDown':
      terminals.scroll(paneId, 'lineDown');
      return true;
    case 'scrollPageUp':
      terminals.scroll(paneId, 'pageUp');
      return true;
    case 'scrollPageDown':
      terminals.scroll(paneId, 'pageDown');
      return true;
    case 'scrollToTop':
      terminals.scroll(paneId, 'top');
      return true;
    case 'scrollToBottom':
      terminals.scroll(paneId, 'bottom');
      return true;
    case 'prevCommand':
      return terminals.jumpToCommand(paneId, -1);
    case 'nextCommand':
      return terminals.jumpToCommand(paneId, 1);
    case 'copyLastCommandOutput':
      void terminals.copyLastOutput(paneId).then((ok) =>
        pushToast(ok ? { tone: 'success', title: 'Copied last command output', timeoutMs: 1800 } : { tone: 'info', title: 'No finished command to copy yet', timeoutMs: 2200 }),
      );
      return true;
    case 'selectLastCommandOutput':
      terminals.selectLastOutput(paneId);
      return true;
    case 'fontSizeIncrease':
      terminals.changeFontSize(paneId, 1);
      return true;
    case 'fontSizeDecrease':
      terminals.changeFontSize(paneId, -1);
      return true;
    case 'fontSizeReset':
      terminals.changeFontSize(paneId, 'reset');
      return true;
    case 'runSnippet': {
      const snippet = state.settings.snippets.find((entry) => entry.id === args?.id);
      if (!snippet) {
        return false;
      }
      terminals.insertText(paneId, snippet.command);
      if (snippet.run) {
        terminals.sendInput(paneId, '\r', true);
      }
      return true;
    }
    case 'sendInput':
      if (typeof args?.input === 'string') {
        terminals.sendInput(paneId, args.input.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\e/g, '\x1b'), true);
      }
      return true;
    case 'openInExplorer': {
      const cwd = runtimeOf(paneId)?.cwd;
      if (cwd) {
        window.lookout.openPath(cwd);
      }
      return true;
    }
    case 'openInVSCode': {
      const cwd = runtimeOf(paneId)?.cwd;
      if (cwd) {
        window.lookout.openInVSCode(cwd);
      }
      return true;
    }
    case 'copyCwd': {
      const cwd = runtimeOf(paneId)?.cwd;
      if (cwd) {
        void navigator.clipboard.writeText(cwd);
        pushToast({ tone: 'success', title: 'Copied folder path', body: cwd, timeoutMs: 1800 });
      }
      return true;
    }
    case 'saveWorkspace':
      saveTabAsWorkspace();
      return true;
    case 'openWorkspace':
      if (typeof args?.id === 'string') {
        openWorkspace(args.id);
      }
      return true;
    default:
      return false;
  }
}

export function commandTitle(command: CommandId): string {
  return COMMANDS[command].title;
}
