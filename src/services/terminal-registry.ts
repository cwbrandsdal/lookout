import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { getTerminalBuffer, subscribeToTerminalStream } from './terminal-stream';

export interface TerminalFontOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  hostElement: HTMLDivElement;
  sessionId?: string;
  opened: boolean;
  webglAddon: WebglAddon | null;
  unsubscribeStream: () => void;
}

const TERMINAL_THEME = {
  background: '#0b1118',
  foreground: '#d8e0ed',
  cursor: '#f0883e',
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

const entries = new Map<string, TerminalEntry>();

export interface TerminalHandle {
  terminal: Terminal;
  fitAddon: FitAddon;
}

export function acquireTerminal(paneId: string, fonts: TerminalFontOptions): TerminalHandle {
  let entry = entries.get(paneId);

  if (!entry) {
    entry = createEntry(paneId, fonts);
    entries.set(paneId, entry);
  } else {
    applyFontOptions(entry.terminal, fonts);
  }

  return { terminal: entry.terminal, fitAddon: entry.fitAddon };
}

export function attachTerminal(paneId: string, container: HTMLElement): void {
  const entry = entries.get(paneId);
  if (!entry) {
    return;
  }

  container.appendChild(entry.hostElement);

  if (!entry.opened) {
    entry.opened = true;
    entry.terminal.open(entry.hostElement);
    installClipboardBridge(entry);
  }

  // Only visible terminals hold a WebGL context: browsers cap the number of
  // live contexts, and detached panes render nothing anyway.
  enableWebglRenderer(entry);
  fitTerminal(paneId);

  if (entry.terminal.rows > 0) {
    entry.terminal.refresh(0, entry.terminal.rows - 1);
  }
}

export function detachTerminal(paneId: string): void {
  const entry = entries.get(paneId);
  if (!entry) {
    return;
  }

  disposeWebglRenderer(entry);
  entry.hostElement.remove();
}

export function fitTerminal(paneId: string): void {
  const entry = entries.get(paneId);
  if (!entry || !entry.opened) {
    return;
  }

  if (entry.hostElement.isConnected && entry.hostElement.clientWidth > 0 && entry.hostElement.clientHeight > 0) {
    entry.fitAddon.fit();
  }
}

export function setTerminalSessionId(paneId: string, sessionId: string | undefined): void {
  const entry = entries.get(paneId);
  if (entry) {
    entry.sessionId = sessionId;
  }
}

export function disposeTerminal(paneId: string): void {
  const entry = entries.get(paneId);
  if (!entry) {
    return;
  }

  entry.unsubscribeStream();
  disposeWebglRenderer(entry);
  entry.terminal.dispose();
  entry.hostElement.remove();
  entries.delete(paneId);
}

export function syncTerminalRegistry(validPaneIds: ReadonlySet<string>): void {
  for (const paneId of entries.keys()) {
    if (!validPaneIds.has(paneId)) {
      disposeTerminal(paneId);
    }
  }
}

function createEntry(paneId: string, fonts: TerminalFontOptions): TerminalEntry {
  const hostElement = document.createElement('div');
  hostElement.className = 'terminal-host';

  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: false,
    cursorInactiveStyle: 'none',
    cursorStyle: 'bar',
    fontFamily: fonts.fontFamily,
    fontSize: fonts.fontSize,
    letterSpacing: fonts.letterSpacing,
    lineHeight: fonts.lineHeight,
    scrollback: 5000,
    theme: TERMINAL_THEME,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';

  const entry: TerminalEntry = {
    terminal,
    fitAddon,
    hostElement,
    opened: false,
    webglAddon: null,
    unsubscribeStream: () => {},
  };

  terminal.onData((data) => {
    const sessionId = entry.sessionId;
    if (sessionId) {
      void window.lookout.writeTerminalData(sessionId, data);
    }
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) {
      return true;
    }

    const key = event.key.toLowerCase();

    if (key === 'c' && terminal.hasSelection()) {
      event.preventDefault();
      void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      return false;
    }

    // xterm maps Ctrl+V to a raw \x16 and suppresses the browser paste event,
    // so paste has to be driven from here. Text goes through terminal.paste()
    // (bracketed paste); a text-less clipboard (e.g. an image) falls through as
    // a literal Ctrl+V so TUIs can read the clipboard themselves.
    if (key === 'v') {
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) {
            terminal.paste(text);
          } else if (entry.sessionId) {
            void window.lookout.writeTerminalData(entry.sessionId, '\x16');
          }
        })
        .catch(() => {});
      return false;
    }

    return true;
  });

  const initialBuffer = getTerminalBuffer(paneId);
  if (initialBuffer) {
    terminal.write(initialBuffer);
  }

  entry.unsubscribeStream = subscribeToTerminalStream(paneId, (event) => {
    if (event.type === 'clear') {
      terminal.reset();
      return;
    }

    terminal.write(event.data);
  });

  return entry;
}

function installClipboardBridge(entry: TerminalEntry): void {
  // When the clipboard holds no text (e.g. an image), forward a literal Ctrl+V
  // to the PTY so TUIs like Claude Code can read the clipboard themselves.
  entry.terminal.textarea?.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) {
      return;
    }

    event.preventDefault();
    const sessionId = entry.sessionId;
    if (sessionId) {
      void window.lookout.writeTerminalData(sessionId, '\x16');
    }
  });
}

function enableWebglRenderer(entry: TerminalEntry): void {
  if (entry.webglAddon || !entry.opened) {
    return;
  }

  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      entry.webglAddon = null;
    });
    entry.terminal.loadAddon(webglAddon);
    entry.webglAddon = webglAddon;
  } catch {
    entry.webglAddon = null;
  }
}

function disposeWebglRenderer(entry: TerminalEntry): void {
  entry.webglAddon?.dispose();
  entry.webglAddon = null;
}

function applyFontOptions(terminal: Terminal, fonts: TerminalFontOptions): void {
  terminal.options.fontFamily = fonts.fontFamily;
  terminal.options.fontSize = fonts.fontSize;
  terminal.options.lineHeight = fonts.lineHeight;
  terminal.options.letterSpacing = fonts.letterSpacing;
}
