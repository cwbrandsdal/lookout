import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Columns2, Copy, FolderOpen, GitBranch, Maximize2, Minimize2, Play, RefreshCcw, Rows2, Square, Trash2, X } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../store/useAppStore';
import { getTerminalBuffer, subscribeToTerminalStream } from '../services/terminal-stream';
import { getRoleDefinition, type PaneDefinition, type ProjectSpace } from '../types/app';
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

const TERMINAL_THEME = {
  background: '#0b1118',
  foreground: '#d8e0ed',
  cursor: '#5a9dff',
  black: '#0b1118',
  brightBlack: '#67748a',
  red: '#ef728f',
  brightRed: '#f48ca3',
  green: '#72d7ac',
  brightGreen: '#95e6c1',
  yellow: '#edbe67',
  brightYellow: '#f4ce8a',
  blue: '#5a9dff',
  brightBlue: '#7fb3ff',
  magenta: '#9588ff',
  brightMagenta: '#b4adff',
  cyan: '#5bd3d7',
  brightCyan: '#80e2e5',
  white: '#d8e0ed',
  brightWhite: '#f1f5fb',
};

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
  const { runtimeFromStore, role, launchPane, stopPane, clearPaneBuffer } = useAppStore(
    useShallow((state) => ({
      runtimeFromStore: state.sessionStateByPaneId[pane.id],
      role: getRoleDefinition(pane.roleId, state.roles),
      launchPane: state.launchPane,
      stopPane: state.stopPane,
      clearPaneBuffer: state.clearPaneBuffer,
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
  const recentPasteWriteRef = useRef<{ text: string; at: number } | null>(null);
  const [gitInfo, setGitInfo] = useState<GitInfoResponse>(NO_GIT_INFO);
  const isDraggable = !isMaximized && Boolean(onDragStart || onDragEnd);

  async function writeClipboardText(text: string) {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !text) {
      return;
    }

    const recentPaste = recentPasteWriteRef.current;
    if (recentPaste && recentPaste.text === text && Date.now() - recentPaste.at < 250) {
      return;
    }

    recentPasteWriteRef.current = {
      text,
      at: Date.now(),
    };

    await window.lookout.writeTerminalData(sessionId, text);
    terminalRef.current?.focus();
  }

  async function launchWithCurrentSize(clearBuffer = true) {
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
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await window.lookout.stopTerminalSession(sessionId);
    }

    await launchWithCurrentSize(true);
  }

  useEffect(() => {
    sessionIdRef.current = runtime.sessionId;
  }, [runtime.sessionId]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.attachCustomKeyEventHandler((event) => {
      const isCopyShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c';
      const isPasteShortcut =
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') ||
        (event.shiftKey && event.key === 'Insert');
      const isShiftInsertPaste = event.shiftKey && event.key === 'Insert';

      if (isCopyShortcut && terminal.hasSelection()) {
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
        return false;
      }

      if (isPasteShortcut && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) {
              return;
            }

            return writeClipboardText(text);
          })
          .catch(() => {});
        return false;
      }

      if (isShiftInsertPaste) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      return true;
    });

    const helperTextarea = containerRef.current.querySelector('textarea');
    const handleNativePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      void writeClipboardText(text);
    };

    helperTextarea?.addEventListener('paste', handleNativePaste, true);

    const dataDisposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void window.lookout.writeTerminalData(sessionId, data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!fitAddonRef.current || !terminalRef.current) {
        return;
      }

      fitAddonRef.current.fit();
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void window.lookout.resizeTerminalSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
      }
    });

    resizeObserver.observe(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      helperTextarea?.removeEventListener('paste', handleNativePaste, true);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const initialBuffer = getTerminalBuffer(pane.id);
    if (initialBuffer) {
      terminal.reset();
      terminal.write(initialBuffer);
    }

    return subscribeToTerminalStream(pane.id, (event) => {
      if (event.type === 'clear') {
        terminal.reset();
        return;
      }

      terminal.write(event.data);
    });
  }, [pane.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.fontFamily = `${terminalFontFace}, "Cascadia Code", "JetBrains Mono", Consolas, monospace`;
    terminal.options.fontSize = terminalFontSize;
    terminal.options.lineHeight = terminalLineHeight;
    terminal.options.letterSpacing = terminalLetterSpacing;
    fitAddon?.fit();

    if (runtime.sessionId) {
      void window.lookout.resizeTerminalSession(runtime.sessionId, terminal.cols, terminal.rows);
    }
  }, [runtime.sessionId, terminalFontFace, terminalFontSize, terminalLetterSpacing, terminalLineHeight]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon || !runtime.sessionId) {
      return;
    }

    fitAddon.fit();
    void window.lookout.resizeTerminalSession(runtime.sessionId, terminal.cols, terminal.rows);
  }, [runtime.sessionId]);

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
  }, [launchPane, pane.autoStart, pane.id, runtime.sessionId, runtime.status, space.id]);

  const effectivePath = runtime.cwd ?? pane.workingDirectory ?? space.rootPath;
  const overlayMessage =
    runtime.status === 'starting'
      ? 'Launching PowerShell session...'
      : runtime.error ?? 'Pane is idle. Launch the session to start a PowerShell-backed terminal.';

  useEffect(() => {
    let isMounted = true;

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
  }, [effectivePath, runtime.status]);

  function handleCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    const selectedText = terminalRef.current?.getSelection() ?? '';
    if (!selectedText) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData('text/plain', selectedText);
  }

  return (
    <article
      className={`terminal-pane ${isDragging ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''} ${isMaximized ? 'is-maximized' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver?.();
      }}
      onDrop={(event) => {
        event.preventDefault();
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
          {gitInfo.ok ? (
            <span className={`terminal-pane__git ${gitInfo.isDirty ? 'is-dirty' : ''}`} title={gitInfo.repoRoot}>
              <GitBranch size={11} />
              <span>{gitInfo.branch}</span>
              {gitInfo.isDirty ? <em>*</em> : null}
            </span>
          ) : null}
          <span className="terminal-pane__path">{effectivePath}</span>
        </div>

        <div className="terminal-pane__controls">
          <span className="role-tag" style={{ borderColor: role.accent, color: role.accent }}>
            {role.displayName}
          </span>
          <span className={`status-pill status-pill--${runtime.status}`}>{runtime.status}</span>
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
          <button className="icon-button" draggable={false} onClick={() => void restartWithCurrentSize()} type="button">
            <RefreshCcw size={14} />
          </button>
          <button className="icon-button" draggable={false} onClick={() => clearPaneBuffer(pane.id)} type="button">
            <Trash2 size={14} />
          </button>
          <button
            className="icon-button"
            draggable={false}
            onClick={() => void navigator.clipboard.writeText(effectivePath)}
            type="button"
          >
            <Copy size={14} />
          </button>
          <button className="icon-button" draggable={false} onClick={() => void window.lookout.openPath(effectivePath)} type="button">
            <FolderOpen size={14} />
          </button>
          {runtime.sessionId ? (
            <button
              className="icon-button icon-button--danger"
              draggable={false}
              onClick={() => void stopPane(pane.id)}
              type="button"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="icon-button icon-button--primary"
              draggable={false}
              onClick={() => void launchWithCurrentSize()}
              type="button"
            >
              <Play size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="terminal-pane__body">
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
      </div>
    </article>
  );
}
