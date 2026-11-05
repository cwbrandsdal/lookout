// Builds the command palette's items for a scope. Pure apart from the `run`
// closures, which call into actions.

import { Folder, FolderKanban, ShieldCheck, SquareTerminal, type LucideIcon } from 'lucide-react';

import { COMMANDS, type CommandId } from '../../shared/commands';
import { listPaneIds } from '../../shared/layout';
import type { ProfileDefinition } from '../../shared/settings';
import {
  activateTab,
  deleteWorkspace,
  focusPane,
  newGridTab,
  newTab,
  openWorkspace,
  paneTitle,
  runCommand,
  shortenPath,
  splitPane,
  tabTitle,
} from '../../state/actions';
import { gitKey, patchUi, type AppState, type TabRuntime } from '../../state/store';
import { chordFor } from './chords';
import { profileGlyph } from './icons';
import type { PaletteScope } from './palette-model';
import type { RankOptions, Rankable } from './rank';

export interface PaletteItem extends Rankable {
  id: string;
  run: () => void;
  icon?: LucideIcon;
  /** Profile glyph shown instead of an icon. */
  glyph?: string;
  /** Tab colour dot instead of an icon ('' = default colour). */
  dot?: string;
  labelMono?: boolean;
  detailMono?: boolean;
  /** Canonical chord (`ctrl+shift+t`). */
  chord?: string;
  branch?: string;
  tag?: string;
  /** Pane rows nested under their tab (only while the query is empty). */
  indent?: boolean;
  danger?: boolean;
}

export type PaletteData = Pick<AppState, 'tabs' | 'activeTabId' | 'runtime' | 'git' | 'settings' | 'workspaces' | 'recentDirectories' | 'homeDir' | 'elevated'>;

export const PLACEHOLDER: Record<PaletteScope, string> = {
  all: 'Search tabs, folders, profiles and commands',
  commands: 'Run a command',
  profiles: 'Open a new tab with…',
  tabs: 'Go to a tab or pane',
  workspaces: 'Open a workspace',
  directories: 'Open a new tab in a folder',
};

export const EMPTY_HINT: Record<PaletteScope, string> = {
  all: 'Nothing to show yet.',
  commands: 'No commands available.',
  profiles: 'No visible profiles. Unhide one in Settings.',
  tabs: 'No open tabs.',
  workspaces: 'No workspaces yet. Save a tab as a workspace from its menu.',
  directories: 'No recent folders yet.',
};

export function rankOptionsFor(scope: PaletteScope, hasQuery: boolean): RankOptions {
  if (scope !== 'all') {
    return { maxTotal: 400 };
  }
  return hasQuery ? { defaultLimit: 6, limits: { Commands: 12 }, maxTotal: 80 } : { limits: { 'Recent folders': 5 }, maxTotal: 400 };
}

export function buildPaletteItems(scope: PaletteScope, data: PaletteData): PaletteItem[] {
  switch (scope) {
    case 'commands':
      return commandItems(data, false);
    case 'profiles':
      return [...profileItems(data, 'New tab'), ...folderItems(data, 'New tab in folder'), ...adminItems(data)];
    case 'tabs':
      return tabItems(data, 'Open tabs');
    case 'workspaces':
      return workspaceItems(data, 'Workspaces');
    case 'directories':
      return folderItems(data, 'New tab in folder');
    case 'all':
      return [
        ...tabItems(data, 'Open tabs'),
        ...workspaceItems(data, 'Workspaces'),
        ...folderItems(data, 'Recent folders'),
        ...profileItems(data, 'New tab'),
        ...commandItems(data, true),
      ];
  }
}

// ---------------------------------------------------------------------------
// Tabs & panes
// ---------------------------------------------------------------------------

function cwdOf(data: PaletteData, tab: TabRuntime, paneId: string): string | undefined {
  return data.runtime[paneId]?.cwd ?? tab.panes[paneId]?.cwd;
}

function branchOf(data: PaletteData, cwd: string | undefined): string | undefined {
  const status = cwd ? data.git[gitKey(cwd)] : null;
  return status?.branch || undefined;
}

function tabChord(index: number, count: number): string | undefined {
  if (index < 8) {
    return chordFor('switchToTab', { index });
  }
  return index === count - 1 ? chordFor('switchToTab', { index: -1 }) : undefined;
}

function tabItems(data: PaletteData, section: string): PaletteItem[] {
  const items: PaletteItem[] = [];
  data.tabs.forEach((tab, index) => {
    const paneIds = listPaneIds(tab.layout);
    const cwd = cwdOf(data, tab, tab.focusedPaneId);
    const titles = paneIds.map(paneTitle);
    items.push({
      id: `tab:${tab.id}`,
      section,
      label: tabTitle(tab),
      detail: shortenPath(cwd, data.homeDir) || undefined,
      detailMono: true,
      dot: tab.color ?? '',
      branch: branchOf(data, cwd),
      tag: tab.id === data.activeTabId ? 'current' : paneIds.length > 1 ? `${paneIds.length} panes` : undefined,
      keywords: titles.join(' '),
      chord: tabChord(index, data.tabs.length),
      run: () => activateTab(tab.id),
    });

    if (paneIds.length < 2) {
      return;
    }
    paneIds.forEach((paneId, paneIndex) => {
      const paneCwd = cwdOf(data, tab, paneId);
      const runtime = data.runtime[paneId];
      items.push({
        id: `pane:${paneId}`,
        section,
        label: titles[paneIndex],
        detail: shortenPath(paneCwd, data.homeDir) || undefined,
        detailMono: true,
        icon: SquareTerminal,
        branch: branchOf(data, paneCwd),
        tag: tab.zoomedPaneId === paneId ? 'zoomed' : runtime?.status === 'exited' ? 'exited' : undefined,
        keywords: [tabTitle(tab), runtime?.currentCommand].filter(Boolean).join(' '),
        indent: true,
        run: () => focusPane(paneId),
      });
    });
  });
  return items;
}

// ---------------------------------------------------------------------------
// Workspaces, folders, profiles
// ---------------------------------------------------------------------------

function workspaceItems(data: PaletteData, section: string): PaletteItem[] {
  const open = new Set(data.tabs.map((tab) => tab.workspaceId).filter(Boolean));
  return data.workspaces.map((workspace) => {
    const paneCount = Object.keys(workspace.panes).length;
    return {
      id: `workspace:${workspace.id}`,
      section,
      label: workspace.name,
      detail: shortenPath(workspace.rootPath, data.homeDir) || undefined,
      detailMono: true,
      icon: workspace.elevate ? ShieldCheck : FolderKanban,
      tag: open.has(workspace.id) ? 'open' : workspace.elevate ? 'admin' : paneCount > 1 ? `${paneCount} panes` : undefined,
      chord: chordFor('openWorkspace', { id: workspace.id }),
      keywords: workspace.elevate ? 'workspace admin elevated' : 'workspace',
      run: () => openWorkspace(workspace.id),
    };
  });
}

function folderItems(data: PaletteData, section: string): PaletteItem[] {
  return data.recentDirectories.map((directory) => ({
    id: `folder:${directory}`,
    section,
    label: shortenPath(directory, data.homeDir),
    labelMono: true,
    icon: Folder,
    keywords: `${directory} folder directory`,
    run: () => newTab({ cwd: directory }),
  }));
}

function visible(data: PaletteData): ProfileDefinition[] {
  return data.settings.profiles.filter((profile) => !profile.hidden);
}

function profileItems(data: PaletteData, section: string): PaletteItem[] {
  return visible(data).map((profile, index) => {
    const glyph = profileGlyph(profile.icon);
    return {
      id: `profile:${profile.id}`,
      section,
      label: profile.name,
      detail: profile.commandline,
      detailMono: true,
      glyph,
      icon: glyph ? undefined : profile.elevate ? ShieldCheck : SquareTerminal,
      tag: profile.id === data.settings.defaultProfile ? 'default' : profile.elevate ? 'admin' : undefined,
      chord: chordFor('newTabProfileIndex', { index }) ?? chordFor('newTab', { profile: profile.id }),
      keywords: 'new tab profile',
      run: () => newTab({ profileId: profile.id }),
    };
  });
}

function adminItems(data: PaletteData): PaletteItem[] {
  if (data.elevated) {
    return [];
  }
  return visible(data)
    .filter((profile) => !profile.elevate)
    .map((profile) => ({
      id: `admin:${profile.id}`,
      section: 'As administrator',
      label: `${profile.name} as administrator`,
      icon: ShieldCheck,
      keywords: 'admin elevated sudo',
      run: () => window.lookout.openAdminWindow([{ type: 'new-tab', profileId: profile.id }]),
    }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Commands that do nothing useful from the palette. */
const HIDDEN_COMMANDS = new Set<CommandId>(['commandPalette', 'findNext', 'findPrev', 'sendInput', 'switchToTab']);

const CATEGORY_ORDER = ['Tabs', 'Panes', 'Terminal', 'Snippets', 'Folder', 'Workspaces', 'Window'];

const KEYWORDS: Partial<Record<CommandId, string>> = {
  clearBuffer: 'cls reset scrollback',
  closePane: 'kill exit',
  togglePaneZoom: 'maximize focus',
  toggleBroadcast: 'sync multiple input',
  splitRight: 'vertical',
  splitDown: 'horizontal',
  openSettings: 'preferences config options',
  openSettingsJson: 'json config',
  copyCwd: 'directory path',
  reopenClosedTab: 'undo restore',
};

const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;

const GRIDS = [
  { label: '2×2', count: 4, columns: 2 },
  { label: '3×2', count: 6, columns: 3 },
  { label: '4×2', count: 8, columns: 4 },
];

function requiresArgs(command: CommandId): boolean {
  const spec = COMMANDS[command];
  const args: string | undefined = 'args' in spec ? spec.args : undefined;
  return Boolean(args && !args.includes('?:'));
}

/** `flat`: everything in one "Commands" section, without entries the 'all' scope already lists. */
function commandItems(data: PaletteData, flat: boolean): PaletteItem[] {
  const groups = new Map<string, PaletteItem[]>();
  const add = (category: string, item: Omit<PaletteItem, 'section'>) => {
    const list = groups.get(category) ?? [];
    list.push({ ...item, section: flat ? 'Commands' : category, keywords: [item.keywords, category].filter(Boolean).join(' ') });
    groups.set(category, list);
  };
  const profiles = visible(data);

  for (const command of Object.keys(COMMANDS) as CommandId[]) {
    const { title, category } = COMMANDS[command];

    switch (command) {
      case 'newTabProfileIndex':
        if (!flat) {
          profiles.forEach((profile, index) =>
            add(category, {
              id: `cmd:newTab:${profile.id}`,
              label: `New tab: ${profile.name}`,
              chord: chordFor('newTabProfileIndex', { index }) ?? chordFor('newTab', { profile: profile.id }),
              keywords: 'profile',
              run: () => newTab({ profileId: profile.id }),
            }),
          );
        }
        continue;
      case 'newTabMenu':
        add(category, { id: `cmd:${command}`, label: title, chord: chordFor(command), run: () => runCommand(command) });
        for (const grid of GRIDS) {
          add(category, {
            id: `cmd:grid:${grid.label}`,
            label: `New grid: ${grid.label}`,
            keywords: 'layout tile panes',
            run: () => newGridTab(grid.count, grid.columns),
          });
        }
        continue;
      case 'focusPane':
      case 'resizePane':
        for (const direction of DIRECTIONS) {
          add(category, {
            id: `cmd:${command}:${direction}`,
            label: `${command === 'focusPane' ? 'Focus' : 'Resize'} pane ${direction}`,
            chord: chordFor(command, { direction }),
            run: () => runCommand(command, { direction }),
          });
        }
        continue;
      case 'runSnippet':
        for (const snippet of data.settings.snippets) {
          add('Snippets', {
            id: `cmd:snippet:${snippet.id}`,
            label: `Run snippet: ${snippet.name}`,
            detail: snippet.command,
            detailMono: true,
            chord: chordFor('runSnippet', { id: snippet.id }),
            run: () => runCommand('runSnippet', { id: snippet.id }),
          });
        }
        continue;
      case 'openWorkspace':
        for (const workspace of data.workspaces) {
          if (!flat) {
            add(category, {
              id: `cmd:openWorkspace:${workspace.id}`,
              label: `Open workspace: ${workspace.name}`,
              chord: chordFor('openWorkspace', { id: workspace.id }),
              run: () => openWorkspace(workspace.id),
            });
          }
          add(category, {
            id: `cmd:deleteWorkspace:${workspace.id}`,
            label: `Delete workspace: ${workspace.name}`,
            danger: true,
            keywords: 'remove',
            run: () =>
              patchUi({
                dialog: {
                  kind: 'confirm',
                  title: 'Delete workspace?',
                  message: `“${workspace.name}” will be removed. Tabs already open from it keep running.`,
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => deleteWorkspace(workspace.id),
                },
              }),
          });
        }
        continue;
    }

    if (HIDDEN_COMMANDS.has(command) || requiresArgs(command)) {
      continue;
    }
    add(category, { id: `cmd:${command}`, label: title, chord: chordFor(command), keywords: KEYWORDS[command], run: () => runCommand(command) });

    if (command === 'splitRight') {
      for (const profile of profiles) {
        add(category, {
          id: `cmd:splitRight:${profile.id}`,
          label: `Split right with ${profile.name}`,
          chord: chordFor('splitRight', { profile: profile.id }),
          keywords: 'profile vertical',
          run: () => splitPane('right', { profileId: profile.id }),
        });
      }
    }
  }

  const order = [...CATEGORY_ORDER, ...[...groups.keys()].filter((category) => !CATEGORY_ORDER.includes(category))];
  return order.flatMap((category) => groups.get(category) ?? []);
}
