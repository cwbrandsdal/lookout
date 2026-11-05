import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { BellRing, ChevronDown, Command, Download, LayoutTemplate, PanelLeftClose, PanelLeftOpen, Plus, Radio, Settings, Shield, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import lookoutLogo from '../assets/lookout-app-icon.png';
import { openNewTabMenu, openTabMenu, openWorkspaceMenu } from './overlays/menus';
import { LayoutGlyph } from './LayoutGlyph';
import { TAB_MIME, useNow } from './ui-helpers';
import {
  activateTab,
  closeTab,
  deleteWorkspace,
  findProfile,
  moveTabToNewWindow,
  newTab,
  openWorkspace,
  renameTab,
  reorderTab,
  saveTabAsWorkspace,
  shortenPath,
  tabTitle,
} from '../state/actions';
import { gitKey, patchUi, setState, useApp, type PaneRuntime, type TabRuntime } from '../state/store';
import { formatDuration } from '../terminal/terminal-manager';
import type { GitStatus } from '../shared/ipc';


export function Sidebar() {
  const { tabs, activeTabId, collapsed, workspaces, elevated, update, renamingTabId, paneDragging, newTabTarget } = useApp(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      collapsed: state.sidebarCollapsed,
      workspaces: state.workspaces,
      elevated: state.elevated,
      update: state.update,
      renamingTabId: state.ui.renamingTabId,
      // Offer "new tab" only when the dragged pane shares its tab with others.
      paneDragging: Boolean(
        state.ui.paneDrag && Object.keys(state.tabs.find((entry) => state.ui.paneDrag!.paneId in entry.panes)?.panes ?? {}).length > 1,
      ),
      newTabTarget: state.ui.paneDrag?.target?.kind === 'newTab',
    })),
  );
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const openWorkspaceIds = useMemo(() => new Set(tabs.map((tab) => tab.workspaceId).filter(Boolean)), [tabs]);

  return (
    <aside className="sidebar">
      <header className="sidebar__head drag">
        <img alt="" className="sidebar__logo" src={lookoutLogo} />
        {!collapsed ? <span className="sidebar__wordmark">Lookout</span> : null}
        {elevated && !collapsed ? (
          <span className="sidebar__admin" title="This window runs as administrator">
            <Shield size={11} /> Admin
          </span>
        ) : null}
        {!collapsed ? (
          <div className="sidebar__new no-drag">
            <button className="icon-btn" onClick={() => newTab()} title="New tab (Ctrl+Shift+T)" type="button">
              <Plus size={15} />
            </button>
            <button
              className="icon-btn icon-btn--sm"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openNewTabMenu(rect.left, rect.bottom + 4);
              }}
              title="New tab with profile (Ctrl+Shift+Space)"
              type="button"
            >
              <ChevronDown size={12} />
            </button>
          </div>
        ) : null}
      </header>

      <div
        className="sidebar__tabs"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDropBefore(undefined);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(TAB_MIME) && event.target === event.currentTarget) {
            event.preventDefault();
            setDropBefore(null);
          }
        }}
        onDrop={(event) => {
          const tabId = event.dataTransfer.getData(TAB_MIME);
          if (tabId) {
            event.preventDefault();
            reorderTab(tabId, null);
          }
          setDropBefore(undefined);
        }}
        role="tablist"
      >
        {tabs.map((tab, index) => (
          <TabRow
            active={tab.id === activeTabId}
            collapsed={collapsed}
            dropIndicator={dropBefore === tab.id}
            index={index}
            key={tab.id}
            onDropBefore={setDropBefore}
            renaming={renamingTabId === tab.id}
            tab={tab}
          />
        ))}
        {dropBefore === null ? <div className="tabrow__drop-end" /> : null}
        {paneDragging && !collapsed ? (
          <div className={`tabrow-drop-new ${newTabTarget ? 'is-target' : ''}`}>
            <Plus size={12} /> Drop here for a new tab
          </div>
        ) : null}
        {collapsed ? (
          <button className="icon-btn sidebar__rail-new" onClick={() => newTab()} title="New tab (Ctrl+Shift+T)" type="button">
            <Plus size={15} />
          </button>
        ) : null}
      </div>

      {!collapsed ? (
        <section className="sidebar__section">
          <header className="sidebar__section-head">
            <button className="sidebar__section-toggle" onClick={() => setWorkspacesOpen((open) => !open)} type="button">
              <ChevronDown className={workspacesOpen ? '' : 'is-collapsed'} size={11} />
              Workspaces
            </button>
            <button className="icon-btn icon-btn--sm" onClick={() => saveTabAsWorkspace()} title="Save current tab as a workspace" type="button">
              <Plus size={12} />
            </button>
          </header>
          {workspacesOpen ? (
            <div className="sidebar__workspaces">
              {workspaces.length ? (
                workspaces.map((workspace) => (
                  <div
                    className="workspace-row"
                    data-workspace-id={workspace.id}
                    key={workspace.id}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openWorkspaceMenu(workspace.id, event.clientX, event.clientY);
                    }}
                  >
                    <button className="workspace-row__main" onClick={() => openWorkspace(workspace.id)} title={workspace.rootPath} type="button">
                      <LayoutTemplate className="workspace-row__icon" size={12} />
                      <span className="truncate">{workspace.name}</span>
                      {workspace.elevate ? (
                        <span className="workspace-row__admin" title={elevated ? 'Runs as administrator' : 'Opens in the administrator window'}>
                          <Shield size={11} />
                        </span>
                      ) : null}
                      {openWorkspaceIds.has(workspace.id) ? <span className="dot dot--accent" title="Open" /> : null}
                    </button>
                    <button className="icon-btn icon-btn--sm icon-btn--danger workspace-row__delete" onClick={() => deleteWorkspace(workspace.id)} title="Delete workspace" type="button">
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="sidebar__hint">Save a tab’s panes, folders and commands as a workspace to reopen it in one click.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <footer className="sidebar__foot">
        <button className="icon-btn" onClick={() => patchUi({ settingsOpen: !useApp.getState().ui.settingsOpen })} title="Settings (Ctrl+,)" type="button">
          <Settings size={14} />
        </button>
        {!collapsed ? (
          <button className="sidebar__palette" onClick={() => patchUi({ palette: { mode: 'all', query: '' } })} title="Command palette (Ctrl+Shift+P)" type="button">
            <Command size={12} />
            <span>Search tabs, commands…</span>
          </button>
        ) : null}
        {update.phase === 'downloaded' ? (
          <button className="sidebar__update" onClick={() => window.lookout.installUpdate()} title={update.error ?? `Restart to install ${update.availableVersion ?? ''}`} type="button">
            <Download size={12} />
            {!collapsed ? <span>Update</span> : null}
          </button>
        ) : null}
        <button
          className="icon-btn"
          onClick={() => setState((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))}
          title={collapsed ? 'Expand sidebar (Ctrl+Shift+B)' : 'Collapse sidebar (Ctrl+Shift+B)'}
          type="button"
        >
          {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
      </footer>

      {!collapsed ? <SidebarResizer /> : null}
    </aside>
  );
}

function SidebarResizer() {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = useApp.getState().sidebarWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(420, Math.max(176, startWidth + moveEvent.clientX - startX));
      setState({ sidebarWidth: Math.round(width) });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return <div className="sidebar__resizer" onDoubleClick={() => setState({ sidebarWidth: 232 })} onPointerDown={onPointerDown} />;
}

interface TabRowProps {
  tab: TabRuntime;
  index: number;
  active: boolean;
  collapsed: boolean;
  renaming: boolean;
  dropIndicator: boolean;
  onDropBefore: (tabId: string | null | undefined) => void;
}

function TabRow({ tab, index, active, collapsed, renaming, dropIndicator, onDropBefore }: TabRowProps) {
  const paneIds = Object.keys(tab.panes);
  // Select each pane runtime as its own key so shallow comparison keeps the snapshot stable.
  const selected = useApp(
    useShallow((state) => {
      const focusedRuntime = state.runtime[tab.focusedPaneId];
      const cwd = focusedRuntime?.cwd ?? tab.panes[tab.focusedPaneId]?.cwd;
      const out: Record<string, unknown> = { git: cwd ? state.git[gitKey(cwd)] : undefined, homeDir: state.homeDir };
      for (const paneId of paneIds) {
        out[`pane:${paneId}`] = state.runtime[paneId];
      }
      return out;
    }),
  );
  const runtimes = paneIds.map((paneId) => selected[`pane:${paneId}`] as PaneRuntime | undefined);
  const git = selected.git as GitStatus | null | undefined;
  const homeDir = selected.homeDir as string;
  const title = tabTitle(tab);
  const now = useNow(runtimes.some((runtime) => runtime?.commandRunning));

  const attention = useMemo(() => {
    const set = new Set<string>();
    paneIds.forEach((paneId, position) => {
      const runtime = runtimes[position];
      if (runtime && (runtime.activity || runtime.bell)) {
        set.add(paneId);
      }
    });
    return set;
  }, [paneIds, runtimes]);

  const focused = useApp((state) => state.runtime[tab.focusedPaneId]);
  const paneTarget = useApp((state) => state.ui.paneDrag?.target?.kind === 'tab' && state.ui.paneDrag.target.tabId === tab.id);
  const status = summarize(runtimes);
  const cwd = focused?.cwd ?? tab.panes[tab.focusedPaneId]?.cwd;
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (active) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(TAB_MIME, tab.id);
    event.dataTransfer.effectAllowed = 'move';
    patchUi({ draggingTabId: tab.id });
  };

  const onDragEnd = (event: DragEvent<HTMLDivElement>) => {
    patchUi({ draggingTabId: null });
    onDropBefore(undefined);
    const outside = event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
    if (outside && event.dataTransfer.dropEffect === 'none') {
      moveTabToNewWindow(tab.id, { x: event.screenX, y: event.screenY });
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(TAB_MIME)) {
      event.preventDefault();
      event.stopPropagation();
      onDropBefore(tab.id);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const tabId = event.dataTransfer.getData(TAB_MIME);
    event.preventDefault();
    event.stopPropagation();
    if (tabId) {
      reorderTab(tabId, tab.id);
    }
    onDropBefore(undefined);
  };

  const branch = git ? `${git.branch}${git.dirty ? '*' : ''}` : null;
  const shortCwd = shortenPath(cwd, homeDir);
  const secondLine = focused?.commandRunning
    ? `▶ ${focused.currentCommand || 'running'}${focused.commandStartedAt ? ` · ${formatDuration(now - focused.commandStartedAt)}` : ''}`
    : shortCwd && shortCwd !== title
      ? shortCwd
      : focused?.kind === 'handoff'
        ? 'Opened from Windows'
        : findProfile(tab.panes[tab.focusedPaneId]?.profileId).name;

  return (
    <div
      aria-selected={active}
      className={['tabrow', active ? 'is-active' : '', dropIndicator ? 'is-drop-before' : '', paneTarget ? 'is-pane-target' : '', status.failed ? 'has-error' : ''].filter(Boolean).join(' ')}
      data-tab-id={tab.id}
      draggable={!renaming}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          closeTab(tab.id);
        }
      }}
      onClick={() => activateTab(tab.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        openTabMenu(tab.id, event.clientX, event.clientY);
      }}
      onDoubleClick={() => patchUi({ renamingTabId: tab.id })}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
      ref={rowRef}
      role="tab"
      style={tab.color ? { ['--tab-color' as string]: tab.color } : undefined}
      title={collapsed ? `${title}${cwd ? `\n${cwd}` : ''}` : undefined}
    >
      <span className="tabrow__glyph">
        {status.progress ? (
          <ProgressRing state={status.progress.state} value={status.progress.value} />
        ) : (
          <LayoutGlyph active={active} attention={attention} focusedPaneId={tab.focusedPaneId} layout={tab.layout} zoomedPaneId={tab.zoomedPaneId} />
        )}
        {collapsed && (status.bell || status.activity) && !active ? <span className="tabrow__rail-dot dot dot--accent" /> : null}
        {collapsed && index < 9 ? <span className="tabrow__rail-index">{index + 1}</span> : null}
      </span>

      {!collapsed ? (
        <span className="tabrow__body">
          {renaming ? (
            <RenameInput initial={tab.title ?? title} onDone={(value) => (value === null ? patchUi({ renamingTabId: null }) : (renameTab(tab.id, value), patchUi({ renamingTabId: null })))} />
          ) : (
            <span className="tabrow__title truncate">{title}</span>
          )}
          <span className="tabrow__meta">
            <span className={`truncate ${focused?.commandRunning ? 'tabrow__running' : ''}`}>{secondLine}</span>
            {branch && !focused?.commandRunning ? <span className="tabrow__branch truncate">{branch}</span> : null}
          </span>
        </span>
      ) : null}

      {!collapsed ? (
        <span className="tabrow__status">
          {tab.broadcast ? <Radio className="tabrow__broadcast" size={11} /> : null}
          {status.bell && !active ? <BellRing className="tabrow__bell" size={11} /> : status.activity && !active ? <span className="dot dot--accent" /> : null}
          {paneIds.length > 1 ? <span className="tabrow__count">{paneIds.length}</span> : null}
          <button
            className="icon-btn icon-btn--sm tabrow__close"
            onClick={(event) => {
              event.stopPropagation();
              closeTab(tab.id);
            }}
            title="Close tab (Ctrl+Shift+W closes the pane)"
            type="button"
          >
            <X size={12} />
          </button>
        </span>
      ) : null}
    </div>
  );
}

function summarize(runtimes: Array<PaneRuntime | undefined>): {
  activity: boolean;
  bell: boolean;
  failed: boolean;
  progress: { state: number; value: number } | null;
} {
  let activity = false;
  let bell = false;
  let failed = false;
  let progress: { state: number; value: number } | null = null;
  for (const runtime of runtimes) {
    if (!runtime) {
      continue;
    }
    activity ||= runtime.activity;
    bell ||= runtime.bell;
    failed ||= runtime.status === 'error';
    if (runtime.progress && (!progress || runtime.progress.state === 2)) {
      progress = runtime.progress;
    }
  }
  return { activity, bell, failed, progress };
}

function ProgressRing({ state, value }: { state: number; value: number }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const indeterminate = state === 3;
  const fraction = indeterminate ? 0.3 : Math.max(0.04, value / 100);
  return (
    <svg className={`progress-ring ${indeterminate ? 'is-indeterminate' : ''} ${state === 2 ? 'is-error' : state === 4 ? 'is-paused' : ''}`} height={16} viewBox="0 0 16 16" width={16}>
      <circle className="progress-ring__track" cx={8} cy={8} r={radius} />
      <circle className="progress-ring__value" cx={8} cy={8} r={radius} strokeDasharray={`${circumference * fraction} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      className="input tabrow__rename"
      onBlur={() => onDone(value)}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          onDone(value);
        } else if (event.key === 'Escape') {
          onDone(null);
        }
      }}
      ref={ref}
      value={value}
    />
  );
}

