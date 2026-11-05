// Context menus for panes, tabs and the new-tab button. Callers pass client
// coordinates; the ContextMenu overlay clamps/flips them to the viewport.

import type { CommandId } from '../../shared/commands';
import {
  closeOtherTabs,
  closePane,
  closeTab,
  deleteWorkspace,
  duplicateTab,
  focusPane,
  moveTabToNewWindow,
  movePaneToNewTab,
  newTab,
  openWorkspace,
  restartPane,
  runCommand,
  saveTabAsWorkspace,
  setTabColor,
  setWorkspaceElevated,
  splitPane,
  tabOfPane,
  runtimeOf,
  toggleBroadcast,
  toggleZoom,
  visibleProfiles,
} from '../../state/actions';
import { getState, patchUi, type MenuItem } from '../../state/store';
import { terminals } from '../../terminal/terminal-manager';
import { chordLabel } from './chords';
import { profileGlyph } from './icons';

/** Store MenuItem plus overlay-only extras. Assignable to MenuItem, so it can live in `ui.contextMenu`. */
export interface OverlayMenuItem extends MenuItem {
  submenu?: OverlayMenuItem[];
  /** CSS color shown as a swatch in the icon slot. */
  swatch?: string;
  /** Short text glyph (profile icon) shown in the icon slot. */
  glyph?: string;
}

export const TAB_COLORS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'Slate', value: '#7b8494' },
  { name: 'Red', value: '#c8636b' },
  { name: 'Amber', value: '#c49a48' },
  { name: 'Green', value: '#5f9e72' },
  { name: 'Teal', value: '#4f9b98' },
  { name: 'Blue', value: '#5f88c8' },
  { name: 'Violet', value: '#8f7ac8' },
  { name: 'Rose', value: '#c070a0' },
  { name: 'Ember', value: '#f0883e' },
];

export function openContextMenu(x: number, y: number, items: OverlayMenuItem[]): void {
  patchUi({ contextMenu: { x, y, items } });
}

export function openPaneMenu(paneId: string, x: number, y: number): void {
  const tab = tabOfPane(paneId);
  if (!tab) {
    return;
  }

  const runtime = runtimeOf(paneId);
  const multiPane = Object.keys(tab.panes).length > 1;
  const hasCwd = Boolean(runtime?.cwd);
  const command = (id: CommandId) => () => {
    focusPane(paneId);
    runCommand(id);
  };

  openContextMenu(x, y, [
    {
      label: 'Copy',
      icon: 'copy',
      hint: chordLabel('copy'),
      disabled: !terminals.hasSelection(paneId),
      run: () => {
        void terminals.copySelection(paneId);
        focusPane(paneId);
      },
    },
    {
      label: 'Paste',
      icon: 'paste',
      hint: chordLabel('paste'),
      run: () => {
        focusPane(paneId);
        void terminals.paste(paneId);
      },
    },
    {
      label: 'Select all',
      icon: 'select-all',
      hint: chordLabel('selectAll'),
      run: () => {
        terminals.selectAll(paneId);
        focusPane(paneId);
      },
    },
    { label: 'Find', icon: 'search', hint: chordLabel('find'), run: command('find') },
    { separator: true },
    { label: 'Split right', icon: 'split-right', hint: chordLabel('splitRight'), run: () => splitPane('right', { paneId }) },
    { label: 'Split down', icon: 'split-down', hint: chordLabel('splitDown'), run: () => splitPane('down', { paneId }) },
    {
      label: 'Zoom pane',
      icon: 'zoom',
      hint: chordLabel('togglePaneZoom'),
      checked: tab.zoomedPaneId === paneId,
      disabled: !multiPane,
      run: () => toggleZoom(paneId),
    },
    { label: 'Move to new tab', icon: 'move-to-tab', hint: chordLabel('movePaneToNewTab'), disabled: !multiPane, run: () => movePaneToNewTab(paneId) },
    { label: 'Broadcast to tab', icon: 'broadcast', hint: chordLabel('toggleBroadcast'), checked: tab.broadcast, run: () => toggleBroadcast(tab.id) },
    { separator: true },
    { label: 'Copy folder path', icon: 'copy-path', hint: chordLabel('copyCwd'), disabled: !hasCwd, run: command('copyCwd') },
    { label: 'Open in Explorer', icon: 'explorer', hint: chordLabel('openInExplorer'), disabled: !hasCwd, run: command('openInExplorer') },
    { label: 'Open in VS Code', icon: 'vscode', hint: chordLabel('openInVSCode'), disabled: !hasCwd, run: command('openInVSCode') },
    { label: 'Copy last command output', icon: 'output', hint: chordLabel('copyLastCommandOutput'), run: command('copyLastCommandOutput') },
    { separator: true },
    {
      label: 'Clear buffer',
      icon: 'clear',
      hint: chordLabel('clearBuffer'),
      run: () => {
        terminals.clear(paneId);
        focusPane(paneId);
      },
    },
    { label: 'Restart', icon: 'restart', hint: chordLabel('restartPane'), disabled: runtime?.kind === 'handoff', run: () => restartPane(paneId) },
    { label: 'Close pane', icon: 'close', hint: chordLabel('closePane'), danger: true, run: () => closePane(paneId) },
  ]);
}

export function openTabMenu(tabId: string, x: number, y: number): void {
  const { tabs, workspaces } = getState();
  const tab = tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    return;
  }

  const savedAs = tab.workspaceId ? workspaces.find((workspace) => workspace.id === tab.workspaceId) : undefined;
  const current = tab.color?.toLowerCase();
  const colors: OverlayMenuItem[] = [
    { label: 'None', icon: 'none', checked: !tab.color, run: () => setTabColor(tabId, undefined) },
    { separator: true },
    ...TAB_COLORS.map((color) => ({
      label: color.name,
      swatch: color.value,
      checked: current === color.value,
      run: () => setTabColor(tabId, color.value),
    })),
  ];

  openContextMenu(x, y, [
    { label: 'Rename', icon: 'rename', hint: chordLabel('renameTab'), run: () => patchUi({ renamingTabId: tabId }) },
    { label: 'Tab color', icon: 'palette', submenu: colors },
    { label: 'Duplicate', icon: 'duplicate', hint: chordLabel('duplicateTab'), run: () => duplicateTab(tabId) },
    { label: savedAs ? 'Update workspace' : 'Save as workspace', icon: 'save', hint: chordLabel('saveWorkspace'), run: () => saveTabAsWorkspace(tabId) },
    { label: 'Move to new window', icon: 'window', hint: chordLabel('moveTabToNewWindow'), disabled: tabs.length < 2, run: () => moveTabToNewWindow(tabId) },
    { label: 'Broadcast input', icon: 'broadcast', hint: chordLabel('toggleBroadcast'), checked: tab.broadcast, run: () => toggleBroadcast(tabId) },
    { separator: true },
    { label: 'Close other tabs', hint: chordLabel('closeOtherTabs'), disabled: tabs.length < 2, run: () => closeOtherTabs(tabId) },
    { label: 'Close tab', icon: 'close', hint: chordLabel('closeTab'), danger: true, run: () => closeTab(tabId) },
  ]);
}

export function openWorkspaceMenu(workspaceId: string, x: number, y: number): void {
  const { workspaces, elevated } = getState();
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return;
  }

  const routed = Boolean(workspace.elevate) && !elevated;
  const items: OverlayMenuItem[] = [
    { label: routed ? 'Open as administrator' : 'Open', icon: routed ? 'admin' : 'workspace', run: () => openWorkspace(workspaceId) },
  ];
  // Inside the administrator window everything already runs elevated.
  if (!elevated) {
    items.push({
      label: 'Run as administrator',
      icon: 'admin',
      checked: Boolean(workspace.elevate),
      run: () => setWorkspaceElevated(workspaceId, !workspace.elevate),
    });
  }
  items.push({ separator: true }, { label: 'Delete workspace', icon: 'trash', danger: true, run: () => deleteWorkspace(workspaceId) });
  openContextMenu(x, y, items);
}

export function openNewTabMenu(x: number, y: number): void {
  const { settings } = getState();
  const profiles: OverlayMenuItem[] = visibleProfiles().map((profile, index) => {
    const glyph = profileGlyph(profile.icon);
    return {
      label: profile.id === settings.defaultProfile ? `${profile.name} (default)` : profile.name,
      glyph,
      icon: glyph ? undefined : profile.elevate ? 'admin' : 'terminal',
      hint: chordLabel('newTabProfileIndex', { index }),
      run: () => newTab({ profileId: profile.id }),
    };
  });

  openContextMenu(x, y, [
    ...profiles,
    { separator: true },
    { label: 'Open administrator window', icon: 'admin', hint: chordLabel('openAdminWindow'), run: () => runCommand('openAdminWindow') },
    { label: 'New window', icon: 'window', hint: chordLabel('newWindow'), run: () => runCommand('newWindow') },
  ]);
}
