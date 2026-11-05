import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, GripVertical, Maximize2, Plus, Regex, WholeWord, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { openContextMenu } from './overlays/menus';
import { nearEdge, type EdgeZone } from './drop-zones';
import { beginPaneDrag } from './pane-drag';
import { profileGlyph, useNow } from './ui-helpers';
import { closePane, findProfile, focusPane, paneTitle, shortenPath, splitPane, toggleZoom, visibleProfiles } from '../state/actions';
import { gitKey, useApp, type TabRuntime } from '../state/store';
import { formatDuration, terminals, type StickyCommand } from '../terminal/terminal-manager';
import { resolveAppTheme, resolveScheme } from '../terminal/theme';

interface PaneViewProps {
  paneId: string;
  tab: TabRuntime;
  focused: boolean;
  multi: boolean;
  showHeader: boolean;
}

const EDGE_LABEL: Record<EdgeZone, string> = { left: 'left', right: 'right', up: 'above', down: 'below' };
const EDGE_CHORD: Partial<Record<EdgeZone, string>> = { right: 'Alt+Shift++', down: 'Alt+Shift+-' };
/** Smallest pane (px) that still offers split anchors on that axis. */
const MIN_SPLITTABLE = 140;
/** Once shown, an anchor stays while the pointer is this close to its edge. */
const KEEP_BAND_PX = 72;

export function PaneView({ paneId, tab, focused, multi, showHeader }: PaneViewProps) {
  const spec = tab.panes[paneId];
  const { runtime, git, homeDir, findOpen, dragState, resizing } = useApp(
    useShallow((state) => {
      const runtime = state.runtime[paneId];
      const cwd = runtime?.cwd ?? spec?.cwd;
      return {
        runtime,
        git: cwd ? state.git[gitKey(cwd)] : undefined,
        homeDir: state.homeDir,
        findOpen: state.ui.findPaneId === paneId,
        dragState: state.ui.paneDrag,
        resizing: state.ui.resizingTabId === tab.id,
      };
    }),
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [sticky, setSticky] = useState<StickyCommand | null>(null);
  const [flash, setFlash] = useState(false);
  const [fileDrop, setFileDrop] = useState(false);
  const [edge, setEdge] = useState<EdgeZone | null>(null);
  const anchorPressed = useRef(false);
  const [size, setSize] = useState('');
  const now = useNow(Boolean(showHeader && runtime?.commandRunning));

  // Attach the (long-lived) xterm instance to this view.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    terminals.ensure(paneId, findProfile(spec?.profileId));
    terminals.attach(paneId, body);

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        terminals.layout(paneId);
        const dims = terminals.dimensions(paneId);
        setSize(dims ? `${dims.cols} × ${dims.rows}` : '');
      });
    });
    observer.observe(body);

    const offSticky = terminals.onSticky(paneId, setSticky);
    const offBell = terminals.onBellFlash(paneId, () => {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 160);
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      offSticky();
      offBell();
      terminals.detach(paneId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  useEffect(() => {
    if (focused && useApp.getState().activeTabId === tab.id) {
      terminals.focus(paneId);
    }
  }, [focused, paneId, tab.id]);

  const cwd = runtime?.cwd ?? spec?.cwd;
  const profile = findProfile(spec?.profileId);
  const settings = useApp((state) => state.settings);
  const termBackground = resolveScheme(settings, profile, resolveAppTheme(settings)).background;
  const exited = runtime?.status === 'exited' || runtime?.status === 'error';
  const dragging = dragState?.paneId === paneId;
  const title = paneTitle(paneId);
  const dropZone = dragState?.target?.kind === 'pane' && dragState.target.paneId === paneId ? dragState.target.zone : null;

  // ---- Edge anchors: move near an edge and a "+" appears there -------------
  // Which anchor shows is a pure function of where the pointer is, so nothing
  // can get stuck: there is no "hovered" state (the preview is CSS :hover), and
  // the anchor stays mounted while it is pressed, so a click that moves a pixel
  // or two still lands.

  const onBodyPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (anchorPressed.current) {
      return;
    }
    if (event.buttons !== 0 || dragState) {
      // Selecting text or dragging a pane: anchors would only get in the way.
      setEdge(null);
      return;
    }
    if ((event.target as Element).closest('.split-anchor')) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setEdge((current) => {
      // Hysteresis: a visible anchor stays while the pointer is within reach of
      // its edge, so moving toward it (or along the edge) never makes it vanish.
      if (current) {
        const distance = current === 'left' ? x : current === 'right' ? rect.width - x : current === 'up' ? y : rect.height - y;
        if (distance >= 0 && distance < KEEP_BAND_PX) {
          return current;
        }
      }
      const next = nearEdge(x, y, rect.width, rect.height);
      if ((next === 'left' || next === 'right') && rect.width < MIN_SPLITTABLE) {
        return null;
      }
      if ((next === 'up' || next === 'down') && rect.height < MIN_SPLITTABLE * 0.6) {
        return null;
      }
      return next;
    });
  };

  const onAnchorPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }
    anchorPressed.current = true;
    const release = () => {
      anchorPressed.current = false;
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  };

  const splitAt = (side: EdgeZone, profileId?: string) => {
    setEdge(null);
    splitPane(side, { paneId, profileId });
  };

  const openSplitMenu = (side: EdgeZone, x: number, y: number) => {
    openContextMenu(x, y, [
      { label: `Split ${EDGE_LABEL[side]} with…`, disabled: true },
      ...visibleProfiles().map((candidate) => ({
        label: candidate.name,
        hint: candidate.id === spec?.profileId ? 'same' : undefined,
        run: () => splitAt(side, candidate.id),
      })),
    ]);
  };

  // ---- Files dropped from Explorer: paste their paths ----------------------

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setFileDrop(true);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setFileDrop(false);
    if (!event.dataTransfer.files.length) {
      return;
    }
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => {
        try {
          return window.lookout.getPathForFile(file);
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .map((path) => (/[\s&()[\]{}^=;!'+,`~]/.test(path) ? `"${path}"` : path));
    if (paths.length) {
      terminals.insertText(paneId, paths.join(' '));
      focusPane(paneId);
    }
  };

  const classes = [
    'pane',
    focused ? 'is-focused' : '',
    multi ? 'is-multi' : '',
    exited ? 'is-exited' : '',
    flash ? 'is-flash' : '',
    tab.broadcast ? 'is-broadcast' : '',
    dragging ? 'is-drag-source' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-pane-id={paneId}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setFileDrop(false);
        }
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseDown={() => {
        if (!focused) {
          focusPane(paneId);
        }
      }}
      style={{ ['--term-bg' as string]: termBackground }}
    >
      {showHeader ? (
        <header
          className="pane__header"
          onDoubleClick={() => toggleZoom(paneId)}
          onPointerDown={(event) => beginPaneDrag(event, paneId)}
          title="Drag to move this pane · double-click to zoom"
        >
          <GripVertical className="pane__grip" size={11} />
          <span className="pane__glyph">{profile.icon ?? profileGlyph(profile.shellKind)}</span>
          <span className="pane__title truncate">{title}</span>
          {cwd && shortenPath(cwd, homeDir) !== title ? <span className="pane__cwd truncate mono">{shortenPath(cwd, homeDir)}</span> : null}
          {git ? <span className="pane__branch truncate mono">{`${git.branch}${git.dirty ? '*' : ''}`}</span> : null}
          <span className="pane__spacer" />
          {runtime?.commandRunning ? (
            <span className="pane__status pane__status--running mono">
              <span className="topbar__pulse" />
              {runtime.commandStartedAt ? formatDuration(now - runtime.commandStartedAt) : ''}
            </span>
          ) : runtime?.lastCommand?.exitCode !== undefined ? (
            <span className={`pane__status mono ${runtime.lastCommand.exitCode === 0 ? 'is-ok' : 'is-error'}`} title={runtime.lastCommand.command}>
              {runtime.lastCommand.exitCode === 0 ? '✓' : `✗ ${runtime.lastCommand.exitCode}`}
            </span>
          ) : null}
          {exited ? <span className="pane__status is-error mono">exited</span> : null}
          <span className="pane__actions">
            <button className="icon-btn icon-btn--sm" onClick={() => toggleZoom(paneId)} title="Zoom (Ctrl+Shift+Z)" type="button">
              <Maximize2 size={11} />
            </button>
            <button className="icon-btn icon-btn--sm icon-btn--danger" onClick={() => closePane(paneId)} title="Close pane (Ctrl+Shift+W)" type="button">
              <X size={12} />
            </button>
          </span>
        </header>
      ) : null}

      <div
        className="pane__body"
        onPointerLeave={() => {
          if (!anchorPressed.current) {
            setEdge(null);
          }
        }}
        onPointerMove={onBodyPointerMove}
      >
        <div className="pane__viewport" ref={bodyRef} />
        {sticky ? <StickyHeader paneId={paneId} sticky={sticky} /> : null}
        {findOpen ? <FindBar paneId={paneId} /> : null}

        {edge && !dragState ? (
          <>
            <button
              aria-label={`Split ${EDGE_LABEL[edge]}`}
              className={`split-anchor split-anchor--${edge}`}
              onClick={(event) => {
                event.stopPropagation();
                splitAt(edge);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openSplitMenu(edge, event.clientX, event.clientY);
              }}
              // Keep keyboard focus in the terminal; don't let the pane treat this as a click inside it.
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={onAnchorPointerDown}
              title={`Split ${EDGE_LABEL[edge]}${EDGE_CHORD[edge] ? ` (${EDGE_CHORD[edge]})` : ''} · right-click to choose a profile`}
              type="button"
            >
              <Plus size={13} strokeWidth={2.25} />
            </button>
            {/* Shown by CSS while the anchor is hovered (.split-anchor:hover + .split-preview). */}
            <div className={`split-preview split-preview--${edge}`}>
              <span className="split-preview__label">New pane</span>
            </div>
          </>
        ) : null}

        {/* The ghost chip next to the pointer names the action; the preview just shows the place. */}
        {dropZone ? <div className={`drop-preview drop-preview--${dropZone}`} /> : null}
        {resizing && size ? <div className="pane__size mono">{size}</div> : null}
        {fileDrop ? <div className="drop-preview drop-preview--files">Drop to paste the paths</div> : null}
      </div>
    </div>
  );
}

function StickyHeader({ paneId, sticky }: { paneId: string; sticky: StickyCommand }) {
  return (
    <button className="sticky" onClick={() => terminals.scrollToLine(paneId, sticky.promptLine)} title="Jump to this command (Ctrl+↑ / Ctrl+↓ move between commands)" type="button">
      <span className="sticky__prompt mono">❯</span>
      <span className="sticky__command truncate mono">{sticky.command}</span>
      {sticky.running ? (
        <span className="sticky__status mono">running</span>
      ) : sticky.exitCode !== undefined ? (
        <span className={`sticky__status mono ${sticky.exitCode === 0 ? 'is-ok' : 'is-error'}`}>{sticky.exitCode === 0 ? '✓' : `✗ ${sticky.exitCode}`}</span>
      ) : null}
    </button>
  );
}

function FindBar({ paneId }: { paneId: string }) {
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<{ resultIndex: number; resultCount: number }>({ resultIndex: -1, resultCount: 0 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const options = { regex, caseSensitive, wholeWord };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return terminals.onFindResults(paneId, setResults);
  }, [paneId]);

  useEffect(() => {
    terminals.find(paneId, query, { regex, caseSensitive, wholeWord }, 1, true);
  }, [caseSensitive, paneId, query, regex, wholeWord]);

  useEffect(() => {
    const step = (event: Event) => {
      const direction = (event as CustomEvent<number>).detail === -1 ? -1 : 1;
      terminals.find(paneId, query, { regex, caseSensitive, wholeWord }, direction);
    };
    window.addEventListener('lookout:find-step', step);
    return () => window.removeEventListener('lookout:find-step', step);
  }, [caseSensitive, paneId, query, regex, wholeWord]);

  const close = () => {
    terminals.clearFind(paneId);
    useApp.setState((state) => ({ ui: { ...state.ui, findPaneId: null } }));
    terminals.focus(paneId);
  };

  return (
    <div className="findbar" onMouseDown={(event) => event.stopPropagation()} onMouseMove={(event) => event.stopPropagation()}>
      <input
        className="input input--mono findbar__input"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F3') {
            event.preventDefault();
            terminals.find(paneId, query, options, event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        placeholder="Find"
        ref={inputRef}
        spellCheck={false}
        value={query}
      />
      <span className="findbar__count mono">{query ? (results.resultCount ? `${results.resultIndex + 1}/${results.resultCount}` : 'No results') : ''}</span>
      <button className={`icon-btn icon-btn--sm ${caseSensitive ? 'is-on' : ''}`} onClick={() => setCaseSensitive((value) => !value)} title="Match case" type="button">
        <CaseSensitive size={13} />
      </button>
      <button className={`icon-btn icon-btn--sm ${wholeWord ? 'is-on' : ''}`} onClick={() => setWholeWord((value) => !value)} title="Whole word" type="button">
        <WholeWord size={13} />
      </button>
      <button className={`icon-btn icon-btn--sm ${regex ? 'is-on' : ''}`} onClick={() => setRegex((value) => !value)} title="Regular expression" type="button">
        <Regex size={13} />
      </button>
      <button className="icon-btn icon-btn--sm" onClick={() => terminals.find(paneId, query, options, -1)} title="Previous (Shift+Enter)" type="button">
        <ArrowUp size={12} />
      </button>
      <button className="icon-btn icon-btn--sm" onClick={() => terminals.find(paneId, query, options, 1)} title="Next (Enter)" type="button">
        <ArrowDown size={12} />
      </button>
      <button className="icon-btn icon-btn--sm" onClick={close} title="Close (Esc)" type="button">
        <X size={12} />
      </button>
    </div>
  );
}
