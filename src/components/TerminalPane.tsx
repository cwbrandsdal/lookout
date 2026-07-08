import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Columns2,
  Copy,
  FolderOpen,
  GitBranch,
  Maximize2,
  Minimize2,
  Play,
  RefreshCcw,
  Rows2,
  Square,
  SquareCode,
  Trash2,
  X,
} from 'lucide-react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../store/useAppStore';
import {
  acquireTerminal,
  attachTerminal,
  detachTerminal,
  fitTerminal,
  setTerminalSessionId,
} from '../services/terminal-registry';
import {
  getDefaultStartupCommandForRole,
  getRoleDefinition,
  getYoloStartupCommand,
  isYoloStartupCommand,
  supportsYoloMode,
  type PaneDefinition,
  type ProjectSpace,
} from '../types/app';
import type { GitInfoResponse } from '../types/electron-api';

interface TerminalPaneProps {
  space: ProjectSpace;
  pane: PaneDefinition;
  dragHandleIcon?: LucideIcon;
  isDragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onRemovePane?: () => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
}

const DEFAULT_RUNTIME = {
  status: 'idle',
  buffer: '',
} as const;

const NO_GIT_INFO: GitInfoResponse = {
  ok: false,
};

const TERMINAL_FONT_FALLBACK = '"Cascadia Code", "JetBrains Mono", Consolas, monospace';

export function TerminalPane({
  space,
  pane,
  dragHandleIcon: DragHandleIcon,
  isDragging = false,
  isDropTarget = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onSplitHorizontal,
  onSplitVertical,
  onRemovePane,
  onToggleMaximize,
  isMaximized = false,
}: TerminalPaneProps) {
  const { runtimeFromStore, role, roles, launchPane, stopPane, clearPaneBuffer, updateSpacePane } = useAppStore(
    useShallow((state) => ({
      runtimeFromStore: state.sessionStateByPaneId[pane.id],
      role: getRoleDefinition(pane.roleId, state.roles),
      roles: state.roles,
      launchPane: state.launchPane,
      stopPane: state.stopPane,
      clearPaneBuffer: state.clearPaneBuffer,
      updateSpacePane: state.updateSpacePane,
    })),
  );
  const terminalFontFace = useAppStore((state) => state.settings.terminalFontFace);
  const terminalFontSize = useAppStore((state) => state.settings.terminalFontSize);
  const terminalLineHeight = useAppStore((state) => state.settings.terminalLineHeight);
  const terminalLetterSpacing = useAppStore((state) => state.settings.terminalLetterSpacing);
  const runtime = runtimeFromStore ?? DEFAULT_RUNTIME;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | undefined>(runtime.sessionId);
  const [gitInfo, setGitInfo] = useState<GitInfoResponse>(NO_GIT_INFO);
  const isDraggable = !isMaximized && Boolean(onDragStart || onDragEnd);
  const isSetupMode = pane.needsSetup;
  const displayedGitInfo = isSetupMode ? NO_GIT_INFO : gitInfo;

  async function launchWithCurrentSize(clearBuffer = true) {
    if (isSetupMode) {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    await launchPane(space.id, pane.id, {
      clearBuffer,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }

  async function restartWithCurrentSize() {
    if (isSetupMode) {
      return;
    }

    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await window.lookout.stopTerminalSession(sessionId);
    }

    await launchWithCurrentSize(true);
  }

  function handleCompleteSetup() {
    updateSpacePane(space.id, pane.id, {
      autoStart: true,
      needsSetup: false,
    });
  }

  useEffect(() => {
    sessionIdRef.current = runtime.sessionId;
    setTerminalSessionId(pane.id, runtime.sessionId);
  }, [pane.id, runtime.sessionId]);

  useEffect(() => {
    if (isSetupMode || !containerRef.current) {
      return;
    }

    const settings = useAppStore.getState().settings;
    const { terminal, fitAddon } = acquireTerminal(pane.id, {
      fontFamily: `${settings.terminalFontFace}, ${TERMINAL_FONT_FALLBACK}`,
      fontSize: settings.terminalFontSize,
      lineHeight: settings.terminalLineHeight,
      letterSpacing: settings.terminalLetterSpacing,
    });

    setTerminalSessionId(pane.id, sessionIdRef.current);
    attachTerminal(pane.id, containerRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal(pane.id);
      const sessionId = sessionIdRef.current;
      if (sessionId && terminalRef.current) {
        void window.lookout.resizeTerminalSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      detachTerminal(pane.id);
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isSetupMode, pane.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.fontFamily = `${terminalFontFace}, ${TERMINAL_FONT_FALLBACK}`;
    terminal.options.fontSize = terminalFontSize;
    terminal.options.lineHeight = terminalLineHeight;
    terminal.options.letterSpacing = terminalLetterSpacing;
    fitTerminal(pane.id);

    if (runtime.sessionId) {
      void window.lookout.resizeTerminalSession(runtime.sessionId, terminal.cols, terminal.rows);
    }
  }, [pane.id, runtime.sessionId, terminalFontFace, terminalFontSize, terminalLetterSpacing, terminalLineHeight]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !runtime.sessionId) {
      return;
    }

    fitTerminal(pane.id);
    void window.lookout.resizeTerminalSession(runtime.sessionId, terminal.cols, terminal.rows);
  }, [pane.id, runtime.sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !pane.autoStart) {
      return;
    }

    if (!runtime.sessionId && runtime.status === 'idle') {
      void launchPane(space.id, pane.id, {
        clearBuffer: true,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }
  }, [isSetupMode, launchPane, pane.autoStart, pane.id, runtime.sessionId, runtime.status, space.id]);

  const effectivePath = runtime.cwd ?? pane.workingDirectory ?? space.rootPath;
  const overlayMessage =
    runtime.status === 'starting'
      ? 'Launching PowerShell session...'
      : runtime.error ?? 'Pane is idle. Launch the session to start a PowerShell-backed terminal.';

  useEffect(() => {
    let isMounted = true;

    if (isSetupMode) {
      return;
    }

    async function refreshGitInfo() {
      if (!effectivePath.trim()) {
        if (isMounted) {
          setGitInfo(NO_GIT_INFO);
        }
        return;
      }

      try {
        const nextGitInfo = await window.lookout.getGitInfo(effectivePath);
        if (isMounted) {
          setGitInfo(nextGitInfo);
        }
      } catch {
        if (isMounted) {
          setGitInfo(NO_GIT_INFO);
        }
      }
    }

    void refreshGitInfo();
    const intervalId = window.setInterval(() => {
      void refreshGitInfo();
    }, 5000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [effectivePath, isSetupMode, runtime.status]);

  function handleCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    const selectedText = terminalRef.current?.getSelection() ?? '';
    if (!selectedText) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData('text/plain', selectedText);
  }

  function isFileDrag(event: ReactDragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleFileDrop(event: ReactDragEvent<HTMLElement>) {
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => {
        try {
          return window.lookout.getPathForFile(file);
        } catch {
          return '';
        }
      })
      .filter(Boolean);

    if (!paths.length) {
      return;
    }

    const terminal = terminalRef.current;
    terminal?.paste(paths.map((filePath) => (/\s/.test(filePath) ? `"${filePath}"` : filePath)).join(' '));
    terminal?.focus();
  }

  return (
    <article
      className={`terminal-pane ${isDragging ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''} ${isMaximized ? 'is-maximized' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (isFileDrag(event)) {
          event.dataTransfer.dropEffect = 'copy';
          return;
        }

        onDragOver?.();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (isFileDrag(event)) {
          handleFileDrop(event);
          return;
        }

        onDrop?.();
      }}
    >
      <header
        className={`terminal-pane__header ${isDraggable ? 'is-draggable' : ''}`}
        draggable={isDraggable}
        onDragEnd={() => onDragEnd?.()}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          onDragStart?.();
        }}
      >
        <div className="terminal-pane__meta">
          {DragHandleIcon ? <DragHandleIcon className="terminal-pane__drag-handle" size={12} /> : null}
          <strong className="terminal-pane__title">{pane.title || role.displayName}</strong>
          {displayedGitInfo.ok ? (
            <span className={`terminal-pane__git ${displayedGitInfo.isDirty ? 'is-dirty' : ''}`} title={displayedGitInfo.repoRoot}>
              <GitBranch size={11} />
              <span>{displayedGitInfo.branch}</span>
              {displayedGitInfo.isDirty ? <em>*</em> : null}
            </span>
          ) : null}
          <span className="terminal-pane__path">{effectivePath}</span>
        </div>

        <div className="terminal-pane__controls">
          <span className="role-tag" style={{ color: role.accent }}>
            {role.displayName}
          </span>
          <span className={`status-pill status-pill--${isSetupMode ? 'setup' : runtime.status}`}>{isSetupMode ? 'setup' : runtime.status}</span>
          {onToggleMaximize ? (
            <button
              className="icon-button"
              draggable={false}
              onClick={() => onToggleMaximize()}
              title={isMaximized ? 'Restore pane to grid' : 'Maximize pane'}
              type="button"
            >
              {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          ) : null}
          {!isMaximized ? (
            <>
              <button className="icon-button" draggable={false} onClick={() => onSplitHorizontal?.()} title="Split left/right" type="button">
                <Columns2 size={12} />
              </button>
              <button className="icon-button" draggable={false} onClick={() => onSplitVertical?.()} title="Split top/bottom" type="button">
                <Rows2 size={12} />
              </button>
              {onRemovePane ? (
                <button
                  className="icon-button icon-button--danger"
                  draggable={false}
                  onClick={() => onRemovePane()}
                  title="Remove pane"
                  type="button"
                >
                  <X size={12} />
                </button>
              ) : null}
            </>
          ) : null}
          {!isSetupMode ? (
            <>
              <button className="icon-button" draggable={false} onClick={() => void restartWithCurrentSize()} type="button">
                <RefreshCcw size={13} />
              </button>
              <button className="icon-button" draggable={false} onClick={() => clearPaneBuffer(pane.id)} type="button">
                <Trash2 size={13} />
              </button>
            </>
          ) : null}
          <button
            className="icon-button"
            draggable={false}
            onClick={() => void navigator.clipboard.writeText(effectivePath)}
            type="button"
          >
            <Copy size={13} />
          </button>
          <button className="icon-button" draggable={false} onClick={() => void window.lookout.openPath(effectivePath)} type="button">
            <FolderOpen size={13} />
          </button>
          <button
            aria-label="Open in VS Code"
            className="icon-button"
            draggable={false}
            onClick={() => void window.lookout.openInVsCode(effectivePath)}
            title="Open in VS Code"
            type="button"
          >
            <SquareCode size={13} />
          </button>
          {!isSetupMode && runtime.sessionId ? (
            <button
              className="icon-button icon-button--danger"
              draggable={false}
              onClick={() => void stopPane(pane.id)}
              type="button"
            >
              <Square size={13} />
            </button>
          ) : !isSetupMode ? (
            <button
              className="icon-button icon-button--primary"
              draggable={false}
              onClick={() => void launchWithCurrentSize()}
              type="button"
            >
              <Play size={13} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="terminal-pane__body">
        {isSetupMode ? (
          <div className="pane-setup">
            <div className="pane-setup__copy">
              <strong>Configure this pane before first launch.</strong>
              <p>Choose the agent, optional YOLO mode, and the path this pane should start in.</p>
            </div>

            <div className="pane-setup__grid">
              <label className="field">
                <span className="field__label">Role / agent</span>
                <select
                  className="field__input"
                  onChange={(event) => updateSpacePane(space.id, pane.id, { roleId: event.target.value })}
                  value={pane.roleId}
                >
                  {roles.map((availableRole) => (
                    <option key={availableRole.id} value={availableRole.id}>
                      {availableRole.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field__label">Path</span>
                <input
                  className="field__input"
                  onChange={(event) => updateSpacePane(space.id, pane.id, { workingDirectory: event.target.value })}
                  placeholder={space.rootPath}
                  value={pane.workingDirectory ?? ''}
                />
              </label>
            </div>

            {supportsYoloMode(role.id) && getYoloStartupCommand(role.id) ? (
              <label className="toggle">
                <input
                  checked={isYoloStartupCommand(role.id, pane.startupCommand ?? role.defaultStartupCommand)}
                  onChange={(event) =>
                    updateSpacePane(space.id, pane.id, {
                      startupCommand: getDefaultStartupCommandForRole(role.id, event.target.checked, roles) ?? '',
                    })
                  }
                  type="checkbox"
                />
                <span>{eventualYoloLabel(role.displayName)}</span>
              </label>
            ) : null}

            <p className="pane-setup__meta">Root path: {space.rootPath}</p>

            <div className="pane-setup__actions">
              <button className="button button--primary" onClick={handleCompleteSetup} type="button">
                <Play size={16} />
                Save and open pane
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              onCopy={handleCopy}
              className="terminal-pane__viewport"
              onClick={() => terminalRef.current?.focus()}
              onMouseDown={() => terminalRef.current?.focus()}
              ref={containerRef}
              tabIndex={0}
            />
            {!runtime.sessionId && runtime.status !== 'running' ? (
              <div className="terminal-pane__overlay">
                <p>{overlayMessage}</p>
                <button
                  className="button button--ghost"
                  disabled={runtime.status === 'starting'}
                  onClick={() => void launchWithCurrentSize()}
                  type="button"
                >
                  <Play size={16} />
                  Launch session
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function eventualYoloLabel(roleDisplayName: string): string {
  return `YOLO mode for ${roleDisplayName}.`;
}
