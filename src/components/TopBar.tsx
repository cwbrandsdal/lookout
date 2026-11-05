import { ArrowDown, ArrowUp, GitBranch, Maximize2, Minimize2, MoreHorizontal, Radio, Search, Shield } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { openTabMenu } from './overlays/menus';
import { profileGlyph, useNow } from './ui-helpers';
import { findProfile, getActiveTab, paneTitle, shortenPath, toggleBroadcast, toggleZoom } from '../state/actions';
import { gitKey, patchUi, useApp } from '../state/store';
import { formatDuration } from '../terminal/terminal-manager';

/**
 * The title strip: context for the focused pane (path breadcrumb, git, the
 * running command) on the left, pane actions on the right, native Windows
 * caption buttons (with snap layouts) painted by the OS at the far right.
 */
export function TopBar() {
  const { tab, runtime, git, homeDir, elevated, windowKind } = useApp(
    useShallow((state) => {
      const active = state.tabs.find((entry) => entry.id === state.activeTabId);
      const paneId = active?.focusedPaneId;
      const runtime = paneId ? state.runtime[paneId] : undefined;
      const cwd = runtime?.cwd ?? (paneId ? active?.panes[paneId]?.cwd : undefined);
      return {
        tab: active,
        runtime,
        git: cwd ? state.git[gitKey(cwd)] : undefined,
        homeDir: state.homeDir,
        elevated: state.elevated,
        windowKind: state.windowKind,
      };
    }),
  );
  const now = useNow(true);

  if (!tab) {
    return <header className="topbar drag" />;
  }

  const paneId = tab.focusedPaneId;
  const spec = tab.panes[paneId];
  const profile = findProfile(spec?.profileId);
  const cwd = runtime?.cwd ?? spec?.cwd;
  const multiPane = Object.keys(tab.panes).length > 1;
  const last = runtime?.lastCommand;

  return (
    <header className={`topbar drag ${windowKind === 'quake' ? 'topbar--quake' : ''}`} onDoubleClick={(event) => event.target === event.currentTarget && window.lookout.toggleMaximize()}>
      <div className="topbar__context">
        {elevated ? (
          <span className="topbar__admin" title="Administrator window">
            <Shield size={12} />
          </span>
        ) : null}
        <span className="topbar__profile" title={profile.name}>
          {profile.icon ?? profileGlyph(profile.shellKind)}
        </span>
        <span className="topbar__title truncate">{paneTitle(paneId)}</span>
        {cwd && shortenPath(cwd, homeDir) !== paneTitle(paneId) ? <Breadcrumb cwd={cwd} homeDir={homeDir} /> : null}
        {git ? (
          <span className={`topbar__git no-drag ${git.dirty ? 'is-dirty' : ''}`} title={`${git.repoRoot}\n${git.staged} staged · ${git.unstaged} changed · ${git.untracked} untracked`}>
            <GitBranch size={11} />
            <span className="truncate">{git.branch}</span>
            {git.ahead ? (
              <span className="topbar__git-count">
                <ArrowUp size={9} />
                {git.ahead}
              </span>
            ) : null}
            {git.behind ? (
              <span className="topbar__git-count">
                <ArrowDown size={9} />
                {git.behind}
              </span>
            ) : null}
            {git.dirty ? <span className="topbar__git-dirty">●</span> : null}
          </span>
        ) : null}
        {runtime?.commandRunning ? (
          <span className="chip chip--accent topbar__running" title={runtime.currentCommand}>
            <span className="topbar__pulse" />
            <span className="truncate mono">{runtime.currentCommand || 'running'}</span>
            {runtime.commandStartedAt ? <span className="mono">{formatDuration(now - runtime.commandStartedAt)}</span> : null}
          </span>
        ) : last && last.exitCode !== undefined && now - last.endedAt < 120_000 ? (
          <span className={`chip mono ${last.exitCode === 0 ? 'chip--ok' : 'chip--error'}`} title={last.command}>
            {last.exitCode === 0 ? '✓' : `✗ ${last.exitCode}`}
            {last.durationMs !== undefined && last.durationMs >= 1000 ? ` ${formatDuration(last.durationMs)}` : ''}
          </span>
        ) : null}
        {tab.zoomedPaneId ? <span className="chip">Zoomed</span> : null}
        {tab.broadcast ? (
          <span className="chip chip--accent">
            <Radio size={10} /> Broadcast
          </span>
        ) : null}
      </div>

      <div className="topbar__actions no-drag">
        {multiPane ? (
          <>
            <button className={`icon-btn ${tab.zoomedPaneId ? 'is-on' : ''}`} onClick={() => toggleZoom()} title="Zoom pane (Ctrl+Shift+Z)" type="button">
              {tab.zoomedPaneId ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button className={`icon-btn ${tab.broadcast ? 'is-on' : ''}`} onClick={() => toggleBroadcast()} title="Broadcast input to all panes" type="button">
              <Radio size={13} />
            </button>
          </>
        ) : null}
        <button className="icon-btn" onClick={() => patchUi({ findPaneId: getActiveTab()?.focusedPaneId ?? null })} title="Find (Ctrl+Shift+F)" type="button">
          <Search size={13} />
        </button>
        <button
          className="icon-btn"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openTabMenu(tab.id, rect.left, rect.bottom + 4);
          }}
          title="Tab actions"
          type="button"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {windowKind === 'normal' ? <div className="topbar__caption" /> : null}
    </header>
  );
}

function Breadcrumb({ cwd, homeDir }: { cwd: string; homeDir: string }) {
  const display = homeDir && cwd.toLowerCase().startsWith(homeDir.toLowerCase()) ? `~${cwd.slice(homeDir.length)}` : cwd;
  const parts = display.split(/[\\/]/).filter(Boolean);
  const isHomeRooted = display.startsWith('~');
  const root = isHomeRooted ? homeDir : '';

  return (
    <nav className="topbar__crumbs no-drag" title={`${cwd}\nClick a segment to copy it · Ctrl+click to open in Explorer`}>
      {parts.map((part, index) => {
        const absolute = isHomeRooted
          ? [root, ...parts.slice(1, index + 1)].join('\\')
          : parts.slice(0, index + 1).join('\\') + (index === 0 && /^[a-z]:$/i.test(part) ? '\\' : '');
        const last = index === parts.length - 1;
        return (
          <span className="topbar__crumb-wrap" key={`${index}-${part}`}>
            {index > 0 ? <span className="topbar__sep">\</span> : null}
            <button
              className={`topbar__crumb ${last ? 'is-last' : ''}`}
              onClick={(event) => {
                if (event.ctrlKey) {
                  window.lookout.openPath(absolute);
                } else {
                  void navigator.clipboard.writeText(absolute);
                }
              }}
              type="button"
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

