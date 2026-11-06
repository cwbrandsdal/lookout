// Owns one xterm.js instance per pane for this window, wires it to the pty
// host, and implements every terminal-level feature: shell integration (OSC
// 633/133/7/9;9), win32-input-mode, command marks, find, links, paste safety,
// bell/progress/notifications, copy semantics and session restore.

import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type IDecoration, type IDisposable, type IMarker, type ITerminalOptions } from '@xterm/xterm';

import type { LaunchSpec, SessionInfo } from '../shared/host-protocol';
import type { LookoutSettings, ProfileDefinition } from '../shared/settings';
import { HostClient } from './host-client';
import { createFileLinkProvider, type FileLinkTarget } from './links';
import { preparePaste } from './paste';
import { fontFamily, resolveAppTheme, resolveScheme, schemeToXtermTheme } from './theme';
import { isLightScheme } from '../shared/color-schemes';
import { Win32InputEncoder } from './win32-input';
import { createRuntime, getState, patchRuntime, setState, type PaneRuntime } from '../state/store';

export interface CommandRecord {
  prompt: IMarker;
  output?: IMarker;
  end?: IMarker;
  command?: string;
  exitCode?: number;
  startedAt?: number;
  endedAt?: number;
  decoration?: IDecoration;
}

export interface StickyCommand {
  command: string;
  exitCode?: number;
  running: boolean;
  promptLine: number;
}

export interface FindState {
  resultIndex: number;
  resultCount: number;
}

export interface ManagerHooks {
  /** A pane's process exited and should close (closeOnExit policy). */
  closePane: (paneId: string) => void;
  restartPane: (paneId: string) => void;
  /** Paste needs confirmation; resolve with the text to paste or null to cancel. */
  confirmPaste: (paneId: string, text: string, reason: 'multiline' | 'large' | 'both') => Promise<string | null>;
  /** Inputs typed into a pane should be mirrored to these panes (broadcast). */
  broadcastTargets: (paneId: string) => string[];
  /** Pane is visible in the active tab. */
  isPaneVisible: (paneId: string) => boolean;
  notify: (paneId: string, title: string, body: string) => void;
  openContextMenu: (paneId: string, x: number, y: number) => void;
  onCommandFinished: (paneId: string, record: CommandRecord) => void;
  showLinkHint: (text: string | null, x?: number, y?: number) => void;
}

interface PaneTerminal {
  paneId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  webgl: WebglAddon | null;
  host: HTMLDivElement;
  opened: boolean;
  sessionId?: string;
  win32: boolean;
  encoder: Win32InputEncoder;
  suppressKeypress: boolean;
  commands: CommandRecord[];
  current: CommandRecord | null;
  fontDelta: number;
  profile?: ProfileDefinition;
  stopListening?: () => void;
  disposables: IDisposable[];
  resizeTimer: number | null;
  lastSent: { cols: number; rows: number };
  copyOnSelectTimer: number | null;
  stickyListeners: Set<(sticky: StickyCommand | null) => void>;
  findListeners: Set<(state: FindState) => void>;
  bellListeners: Set<() => void>;
  lastSticky: string;
  restarting: boolean;
  exited: boolean;
  /** When the current shell was started (its startup banner/prompt is not "activity"). */
  startedAt: number;
}

const MAX_WEBGL_CONTEXTS = 12;
const ESCAPE_CHARS = /\x1b|\x9b/g;

function unescapeOsc633(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_match, _escaped: string, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'));
}

function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
      return null;
    }
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[a-zA-Z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, '\\');
  } catch {
    return null;
  }
}

export class TerminalManager {
  readonly host = new HostClient();
  private readonly panes = new Map<string, PaneTerminal>();
  private webglCount = 0;
  private settings!: LookoutSettings;
  private windowsBuild = 0;
  private hooks!: ManagerHooks;
  private lastKnownSize = { cols: 120, rows: 30 };

  init(options: { settings: LookoutSettings; windowsBuild: number; hooks: ManagerHooks }): void {
    this.settings = options.settings;
    this.windowsBuild = options.windowsBuild;
    this.hooks = options.hooks;
  }

  has(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  // ---------------------------------------------------------------------------
  // Creation & options
  // ---------------------------------------------------------------------------

  private baseOptions(profile?: ProfileDefinition, fontDelta = 0): ITerminalOptions {
    const settings = this.settings;
    const font = { ...settings.font, ...profile?.font };
    const scheme = resolveScheme(settings, profile, resolveAppTheme(settings));

    return {
      allowProposedApi: true,
      allowTransparency: false,
      altClickMovesCursor: true,
      cursorBlink: profile?.cursorBlink ?? settings.terminal.cursorBlink,
      cursorStyle: profile?.cursorStyle ?? settings.terminal.cursorStyle,
      cursorInactiveStyle: 'outline',
      customGlyphs: true,
      drawBoldTextInBrightColors: false,
      fastScrollSensitivity: 5,
      fontFamily: fontFamily(font.face),
      fontSize: Math.max(6, Math.min(72, font.size + fontDelta)),
      fontWeight: font.weight,
      fontWeightBold: font.weightBold,
      letterSpacing: font.letterSpacing,
      lineHeight: font.lineHeight,
      // 1 = automatic, like Windows Terminal's "adjust indistinguishable colors":
      // keeps e.g. PSReadLine's bright-white numbers readable on light schemes.
      minimumContrastRatio:
        settings.terminal.minimumContrastRatio > 1 ? settings.terminal.minimumContrastRatio : isLightScheme(scheme) ? 3 : 1.5,
      overviewRuler: { width: 8 },
      rescaleOverlappingGlyphs: true,
      rightClickSelectsWord: false,
      scrollback: settings.terminal.scrollback,
      scrollOnUserInput: true,
      smoothScrollDuration: settings.terminal.smoothScroll ? 90 : 0,
      theme: schemeToXtermTheme(scheme),
      windowsPty: { backend: 'conpty', buildNumber: this.windowsBuild },
      wordSeparator: settings.terminal.wordSeparators,
    };
  }

  ensure(paneId: string, profile?: ProfileDefinition): PaneTerminal {
    const existing = this.panes.get(paneId);
    if (existing) {
      return existing;
    }

    const host = document.createElement('div');
    host.className = 'xterm-host';
    const term = new Terminal({
      ...this.baseOptions(profile),
      linkHandler: {
        activate: (event, text) => this.openUrl(event, text),
        hover: (event, text) => this.hooks.showLinkHint(this.linkHint(text), event.clientX, event.clientY),
        leave: () => this.hooks.showLinkHint(null),
        allowNonHttpProtocols: false,
      },
    });

    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 2000 });
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    this.loadUnicode(term);
    term.loadAddon(
      new WebLinksAddon((event, uri) => this.openUrl(event, uri), {
        hover: (event, text) => this.hooks.showLinkHint(this.linkHint(text), event.clientX, event.clientY),
        leave: () => this.hooks.showLinkHint(null),
      }),
    );
    term.loadAddon(
      new ClipboardAddon(undefined, {
        // OSC 52: programs may write the clipboard (tmux, vim, ssh sessions) but never read it.
        readText: () => '',
        writeText: (_selection, text) => navigator.clipboard.writeText(text).catch(() => undefined),
      }),
    );
    try {
      term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 64, pixelLimit: 16_777_216, showPlaceholder: true }));
    } catch {
      // Image support is optional.
    }

    const pane: PaneTerminal = {
      paneId,
      term,
      fit,
      search,
      serialize,
      webgl: null,
      host,
      opened: false,
      win32: false,
      encoder: new Win32InputEncoder(),
      suppressKeypress: false,
      commands: [],
      current: null,
      fontDelta: 0,
      profile,
      disposables: [],
      resizeTimer: null,
      lastSent: { cols: 0, rows: 0 },
      copyOnSelectTimer: null,
      stickyListeners: new Set(),
      findListeners: new Set(),
      bellListeners: new Set(),
      lastSticky: '',
      restarting: false,
      exited: false,
      startedAt: Date.now(),
    };
    this.panes.set(paneId, pane);

    this.wireTerminal(pane);
    return pane;
  }

  private loadUnicode(term: Terminal): void {
    if (this.settings.terminal.unicodeVersion === 'graphemes') {
      try {
        term.loadAddon(new UnicodeGraphemesAddon());
        term.unicode.activeVersion = '15-graphemes';
        return;
      } catch {
        // Fall back to Unicode 11 widths.
      }
    }
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  }

  private linkHint(text: string): string {
    const short = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    return this.settings.terminal.linkRequiresCtrl ? `${short}  ·  Ctrl+click to open` : short;
  }

  private openUrl(event: MouseEvent, uri: string): void {
    if (this.settings.terminal.linkRequiresCtrl && !event.ctrlKey) {
      return;
    }
    window.lookout.openExternal(uri);
  }

  private wireTerminal(pane: PaneTerminal): void {
    const { term } = pane;
    const parser = term.parser;

    pane.disposables.push(
      term.onData((data) => this.sendInput(pane.paneId, data, true)),
      term.onBinary((data) => this.sendInput(pane.paneId, data, true)),
      term.onTitleChange((title) => patchRuntime(pane.paneId, { title })),
      term.onBell(() => this.handleBell(pane)),
      term.onScroll(() => this.updateSticky(pane)),
      term.onRender(() => this.updateSticky(pane)),
      term.onSelectionChange(() => this.handleSelectionChange(pane)),
      pane.search.onDidChangeResults((event) => {
        pane.findListeners.forEach((listener) => listener({ resultIndex: event.resultIndex, resultCount: event.resultCount }));
      }),

      // win32-input-mode (CSI ? 9001 h/l), requested by ConPTY.
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this.handleWin32Mode(pane, params, true)),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this.handleWin32Mode(pane, params, false)),

      // Shell integration.
      parser.registerOscHandler(633, (data) => this.handleShellIntegration(pane, data)),
      parser.registerOscHandler(133, (data) => this.handleShellIntegration(pane, data)),
      parser.registerOscHandler(7, (data) => {
        const cwd = fileUrlToPath(data);
        if (cwd) {
          this.setCwd(pane, cwd);
        }
        return true;
      }),
      parser.registerOscHandler(9, (data) => this.handleOsc9(pane, data)),
      parser.registerOscHandler(777, (data) => {
        const [kind, title, ...body] = data.split(';');
        if (kind === 'notify') {
          this.handleNotification(pane, title || 'Notification', body.join(';'));
        }
        return true;
      }),
      parser.registerOscHandler(1337, (data) => {
        if (data.startsWith('CurrentDir=')) {
          this.setCwd(pane, data.slice('CurrentDir='.length));
          return true;
        }
        return false;
      }),
    );

    term.attachCustomKeyEventHandler((event) => this.handleKey(pane, event));
    term.attachCustomWheelEventHandler(() => true);

    this.registerFileLinks(pane);

    term.onWriteParsed(() => {
      // A shell's own startup output (banner, first prompt) is not news.
      if (Date.now() - pane.startedAt < 3000) {
        return;
      }
      if (!this.hooks.isPaneVisible(pane.paneId)) {
        const runtime = getState().runtime[pane.paneId];
        if (runtime && !runtime.activity) {
          patchRuntime(pane.paneId, { activity: true });
        }
      }
    });
  }

  private registerFileLinks(pane: PaneTerminal): void {
    pane.disposables.push(
      pane.term.registerLinkProvider(
        createFileLinkProvider(pane.term, {
          getCwd: () => getState().runtime[pane.paneId]?.cwd,
          probe: (inputs, cwd) => window.lookout.probePaths(inputs, cwd),
          activate: (event, target) => this.openFileLink(event, target),
          hover: (event, target) =>
            this.hooks.showLinkHint(
              `${target.path}${target.line ? `:${target.line}` : ''}${this.settings.terminal.linkRequiresCtrl ? '  ·  Ctrl+click to open' : ''}`,
              event.clientX,
              event.clientY,
            ),
          leave: () => this.hooks.showLinkHint(null),
        }),
      ),
    );
  }

  private openFileLink(event: MouseEvent, target: FileLinkTarget): void {
    if (this.settings.terminal.linkRequiresCtrl && !event.ctrlKey) {
      return;
    }
    if (target.isDirectory) {
      window.lookout.openPath(target.path);
      return;
    }
    window.lookout.openInVSCode(target.path, target.line, target.column);
  }

  // ---------------------------------------------------------------------------
  // Keyboard & input
  // ---------------------------------------------------------------------------

  private handleKey(pane: PaneTerminal, event: KeyboardEvent): boolean {
    const runtime = getState().runtime[pane.paneId];

    if (runtime && (runtime.status === 'exited' || runtime.status === 'error') && runtime.kind === 'shell') {
      if (event.type === 'keydown' && event.key === 'Enter') {
        this.hooks.restartPane(pane.paneId);
      }
      return false;
    }

    if (!pane.win32) {
      return true;
    }

    if (event.type === 'keypress') {
      return !pane.suppressKeypress;
    }

    const sequence = pane.encoder.encode(event as Parameters<Win32InputEncoder['encode']>[0]);
    if (sequence === null) {
      if (event.type === 'keydown') {
        pane.suppressKeypress = false;
      }
      return true;
    }

    if (event.type === 'keydown') {
      pane.suppressKeypress = true;
    }
    if (sequence) {
      this.sendInput(pane.paneId, sequence, event.type === 'keydown' && event.key === 'Enter');
    }
    event.preventDefault();
    return false;
  }

  private handleWin32Mode(pane: PaneTerminal, params: (number | number[])[], enable: boolean): boolean {
    const flat = params.flatMap((param) => (Array.isArray(param) ? param : [param]));
    if (!flat.includes(9001)) {
      return false;
    }
    pane.win32 = enable;
    if (!enable) {
      pane.encoder.releaseAll();
    }
    return flat.length === 1;
  }

  /** Sends user input to the pane's session (and its broadcast peers). */
  sendInput(paneId: string, data: string, fromUser: boolean): void {
    const targets = fromUser ? [paneId, ...this.hooks.broadcastTargets(paneId)] : [paneId];
    for (const target of targets) {
      const pane = this.panes.get(target);
      if (!pane?.sessionId) {
        continue;
      }
      this.host.input(pane.sessionId, data);
      if (fromUser && /\r/.test(data)) {
        const runtime = getState().runtime[target];
        if (runtime && !runtime.inputSincePrompt) {
          patchRuntime(target, { inputSincePrompt: true });
        }
      }
    }
  }

  /** Inserts text as if pasted (bracketed paste aware), without the safety prompts. */
  insertText(paneId: string, text: string): void {
    this.panes.get(paneId)?.term.paste(text);
  }

  // ---------------------------------------------------------------------------
  // Shell integration
  // ---------------------------------------------------------------------------

  private setCwd(pane: PaneTerminal, cwd: string): void {
    const clean = cwd.trim();
    if (clean) {
      patchRuntime(pane.paneId, { cwd: clean, integrated: true });
    }
  }

  private handleShellIntegration(pane: PaneTerminal, data: string): boolean {
    const [kind, ...rest] = data.split(';');
    const { term } = pane;
    const now = Date.now();

    switch (kind) {
      case 'A': {
        if (pane.current && !pane.current.end) {
          // Prompt without a D (e.g. cmd): close the previous record here.
          pane.current.end = term.registerMarker(0);
          pane.current.endedAt = now;
          this.finishCommand(pane, pane.current);
        }
        const record: CommandRecord = { prompt: term.registerMarker(0) };
        record.prompt.onDispose(() => {
          pane.commands = pane.commands.filter((entry) => entry !== record);
        });
        pane.current = record;
        pane.commands.push(record);
        if (pane.commands.length > 2000) {
          pane.commands.splice(0, pane.commands.length - 2000);
        }
        patchRuntime(pane.paneId, { integrated: true, inputSincePrompt: false, commandRunning: false });
        return true;
      }
      case 'B':
        return true;
      case 'C': {
        const record = pane.current;
        if (record) {
          record.output = term.registerMarker(0);
          record.startedAt = now;
        }
        patchRuntime(pane.paneId, { commandRunning: true, commandStartedAt: now, currentCommand: record?.command });
        return true;
      }
      case 'D': {
        const record = pane.current;
        const exitCode = rest[0] !== undefined && rest[0] !== '' ? Number(rest[0]) : undefined;
        if (record && !record.end) {
          record.end = term.registerMarker(0);
          record.exitCode = Number.isFinite(exitCode) ? exitCode : undefined;
          record.endedAt = now;
          this.finishCommand(pane, record);
        }
        patchRuntime(pane.paneId, { commandRunning: false, currentCommand: undefined });
        return true;
      }
      case 'E': {
        if (pane.current) {
          pane.current.command = unescapeOsc633(rest[0] ?? '');
        }
        return true;
      }
      case 'P': {
        const property = rest.join(';');
        if (property.startsWith('Cwd=')) {
          this.setCwd(pane, unescapeOsc633(property.slice(4)));
        }
        return true;
      }
      default:
        return true;
    }
  }

  private finishCommand(pane: PaneTerminal, record: CommandRecord): void {
    const ran = Boolean(record.output || record.command);
    if (!ran) {
      return;
    }

    const failed = record.exitCode !== undefined && record.exitCode !== 0;
    const color = failed ? '#f26d78' : record.exitCode === undefined ? '#6b7586' : '#5fbf7a';
    try {
      record.decoration?.dispose();
      record.decoration = pane.term.registerDecoration({
        marker: record.prompt,
        x: 0,
        width: 1,
        layer: 'top',
        overviewRulerOptions: { color, position: 'left' },
      });
      record.decoration?.onRender((element) => {
        element.classList.add('cmd-mark', failed ? 'cmd-mark--error' : record.exitCode === undefined ? 'cmd-mark--unknown' : 'cmd-mark--ok');
        element.title = `${record.command ?? 'Command'}${record.exitCode !== undefined ? ` — exit ${record.exitCode}` : ''}${
          record.startedAt && record.endedAt ? ` · ${formatDuration(record.endedAt - record.startedAt)}` : ''
        }`;
      });
    } catch {
      // Decorations are cosmetic.
    }

    patchRuntime(pane.paneId, {
      lastCommand: {
        command: record.command,
        exitCode: record.exitCode,
        durationMs: record.startedAt && record.endedAt ? record.endedAt - record.startedAt : undefined,
        endedAt: record.endedAt ?? Date.now(),
      },
    });
    this.hooks.onCommandFinished(pane.paneId, record);
  }

  private handleOsc9(pane: PaneTerminal, data: string): boolean {
    const [first, second, third] = data.split(';');
    if (first === '4') {
      const state = Number(second ?? 0) || 0;
      const value = Math.max(0, Math.min(100, Number(third ?? 0) || 0));
      patchRuntime(pane.paneId, { progress: state === 0 ? undefined : { state, value } });
      return true;
    }
    if (first === '9' && second) {
      this.setCwd(pane, data.slice(2).replace(/^"|"$/g, ''));
      return true;
    }
    if (/^\d+$/.test(first ?? '')) {
      // Other ConEmu sub-commands: ignore quietly.
      return true;
    }
    this.handleNotification(pane, 'Terminal notification', data);
    return true;
  }

  private handleNotification(pane: PaneTerminal, title: string, body: string): void {
    const visible = this.hooks.isPaneVisible(pane.paneId) && getState().flags.focused;
    if (!visible) {
      patchRuntime(pane.paneId, { bell: true });
    }
    this.hooks.notify(pane.paneId, title, body);
  }

  private handleBell(pane: PaneTerminal): void {
    const { bell } = this.settings.terminal;
    if (bell.visual) {
      pane.bellListeners.forEach((listener) => listener());
    }
    if (bell.sound) {
      window.lookout.beep();
    }
    const visible = this.hooks.isPaneVisible(pane.paneId) && getState().flags.focused;
    if (!visible) {
      patchRuntime(pane.paneId, { bell: true });
      if (bell.taskbar) {
        window.lookout.flashFrame();
      }
    }
  }

  private handleSelectionChange(pane: PaneTerminal): void {
    if (!this.settings.terminal.copyOnSelect || !pane.term.hasSelection()) {
      return;
    }
    if (pane.copyOnSelectTimer !== null) {
      window.clearTimeout(pane.copyOnSelectTimer);
    }
    pane.copyOnSelectTimer = window.setTimeout(() => {
      pane.copyOnSelectTimer = null;
      void this.copySelection(pane.paneId, false);
    }, 120);
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  private listen(pane: PaneTerminal, sessionId: string): void {
    pane.stopListening?.();
    pane.sessionId = sessionId;
    pane.stopListening = this.host.listen(sessionId, {
      onData: (data, done) => pane.term.write(data, done),
      onExit: (exitCode) => this.handleExit(pane, exitCode),
    });
  }

  private currentSize(pane: PaneTerminal): { cols: number; rows: number } {
    if (pane.opened && pane.host.isConnected && pane.host.clientWidth > 0) {
      try {
        const dims = pane.fit.proposeDimensions();
        if (dims && dims.cols > 1 && dims.rows > 1) {
          return { cols: dims.cols, rows: dims.rows };
        }
      } catch {
        // fall through
      }
    }
    return pane.term.cols > 2 && pane.opened ? { cols: pane.term.cols, rows: pane.term.rows } : this.lastKnownSize;
  }

  async start(paneId: string, launch: LaunchSpec, profile?: ProfileDefinition, restoredBuffer?: string | null): Promise<void> {
    const pane = this.ensure(paneId, profile);
    pane.profile = profile;
    pane.exited = false;
    const size = this.currentSize(pane);
    if (pane.term.cols !== size.cols || pane.term.rows !== size.rows) {
      pane.term.resize(size.cols, size.rows);
    }

    let spawnLaunch = launch;
    if (restoredBuffer) {
      // Write the previous session, then let ConPTY inherit the cursor so the new
      // shell continues right below it (like VS Code) instead of clearing it.
      const restoredText = `${restoredBuffer}\x1b[0m\r\n\x1b[2m\x1b[38;5;244m── restored · ${new Date().toLocaleString()} ──\x1b[0m\r\n`;
      await new Promise<void>((resolve) => pane.term.write(restoredText, resolve));
      // The host mirror gets the identical text, so reattach snapshots match exactly.
      spawnLaunch = { ...launch, inheritCursor: true, restoredBuffer: restoredText };
      patchRuntime(paneId, { restored: true });
    }

    pane.startedAt = Date.now();
    patchRuntime(paneId, { status: 'starting', error: undefined, exitCode: undefined, commandRunning: false, inputSincePrompt: false });
    const result = await this.host.create(paneId, spawnLaunch, size.cols, size.rows);
    if (!this.panes.has(paneId)) {
      if (result.ok) {
        this.host.kill(result.session.sessionId);
      }
      return;
    }

    if (!result.ok) {
      pane.term.write(`\r\n\x1b[31m✖ Could not start the shell:\x1b[0m ${result.error}\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n`);
      patchRuntime(paneId, { status: 'error', error: result.error });
      return;
    }

    this.bindSession(pane, result.session);
  }

  /** Attaches an existing host session (renderer reload, moved tab, handoff). */
  async adopt(paneId: string, sessionId: string, profile?: ProfileDefinition): Promise<boolean> {
    const pane = this.ensure(paneId, profile);
    pane.profile = profile;
    const size = this.currentSize(pane);
    const result = await this.host.attach(sessionId, paneId, size.cols, size.rows);
    if (!result.ok) {
      return false;
    }

    pane.term.reset();
    pane.term.resize(Math.max(2, result.session.cols), Math.max(2, result.session.rows));
    if (result.snapshot) {
      pane.term.write(result.snapshot);
    }
    this.bindSession(pane, result.session);
    if (result.session.exited) {
      this.handleExit(pane, result.session.exitCode ?? 0);
    }
    this.layout(paneId);
    return true;
  }

  private bindSession(pane: PaneTerminal, session: SessionInfo): void {
    this.listen(pane, session.sessionId);
    pane.lastSent = { cols: session.cols, rows: session.rows };
    patchRuntime(pane.paneId, {
      sessionId: session.sessionId,
      status: session.exited ? 'exited' : 'running',
      shellKind: session.shellKind,
      integrated: session.integrated,
      cwd: getState().runtime[pane.paneId]?.cwd ?? session.cwd,
      kind: session.kind,
    });
    this.layout(pane.paneId);
  }

  private handleExit(pane: PaneTerminal, exitCode: number): void {
    if (pane.exited) {
      return;
    }
    pane.exited = true;
    pane.stopListening?.();
    pane.stopListening = undefined;
    pane.sessionId = undefined;
    pane.win32 = false;
    pane.encoder.releaseAll();

    if (pane.restarting) {
      return;
    }

    const runtime = getState().runtime[pane.paneId];
    const policy = pane.profile?.closeOnExit ?? this.settings.terminal.closeOnExit;
    patchRuntime(pane.paneId, { status: 'exited', exitCode, sessionId: undefined, commandRunning: false, progress: undefined });

    if (policy === 'always' || (policy === 'graceful' && exitCode === 0) || runtime?.kind === 'handoff') {
      this.hooks.closePane(pane.paneId);
      return;
    }

    pane.term.write(
      `\r\n\x1b[2m\x1b[38;5;244m[process exited with code ${exitCode}${exitCode > 255 ? ` (0x${exitCode.toString(16)})` : ''}]  Press Enter to restart.\x1b[0m\r\n`,
    );
  }

  async restart(paneId: string, launch: LaunchSpec, profile?: ProfileDefinition): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }

    if (pane.sessionId) {
      pane.restarting = true;
      const sessionId = pane.sessionId;
      pane.stopListening?.();
      pane.stopListening = undefined;
      pane.sessionId = undefined;
      this.host.kill(sessionId);
    }

    pane.restarting = false;
    pane.term.reset();
    pane.commands.forEach((record) => record.decoration?.dispose());
    pane.commands = [];
    pane.current = null;
    pane.win32 = false;
    await this.start(paneId, launch, profile);
  }

  /** Kills the pane's session and disposes its terminal. */
  destroy(paneId: string, killSession = true): void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }

    if (killSession && pane.sessionId) {
      pane.restarting = true;
      this.host.kill(pane.sessionId);
    }
    pane.stopListening?.();
    pane.disposables.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch {
        // ignore
      }
    });
    this.releaseWebgl(pane);
    pane.term.dispose();
    pane.host.remove();
    this.panes.delete(paneId);
  }

  sessionIdOf(paneId: string): string | undefined {
    return this.panes.get(paneId)?.sessionId;
  }

  // ---------------------------------------------------------------------------
  // View attachment, sizing, rendering
  // ---------------------------------------------------------------------------

  attach(paneId: string, container: HTMLElement): void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }

    if (pane.host.parentElement !== container) {
      container.appendChild(pane.host);
    }

    if (!pane.opened) {
      pane.opened = true;
      pane.term.open(pane.host);
      // Focus moving to a dialog or the palette mid-chord (Ctrl+V → paste dialog) means the
      // modifier's key-up never reaches xterm; release held keys whenever the terminal loses focus.
      pane.term.textarea?.addEventListener('blur', () => this.releaseKeys(pane));
      pane.host.addEventListener('contextmenu', (event) => this.handleContextMenu(pane, event));
      pane.host.addEventListener('auxclick', (event) => {
        if (event.button === 1 && this.settings.terminal.middleClickPaste) {
          event.preventDefault();
          void this.paste(paneId);
        }
      });
    }

    this.enableWebgl(pane);
    this.layout(paneId);
    pane.term.refresh(0, Math.max(0, pane.term.rows - 1));
  }

  detach(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }
    this.releaseWebgl(pane);
    pane.host.remove();
  }

  private enableWebgl(pane: PaneTerminal): void {
    if (pane.webgl || !pane.opened || this.settings.terminal.gpuAcceleration === 'off' || this.webglCount >= MAX_WEBGL_CONTEXTS) {
      return;
    }

    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        this.releaseWebgl(pane);
        // GPU reset / driver update / sleep: try again shortly.
        window.setTimeout(() => {
          if (pane.host.isConnected) {
            this.enableWebgl(pane);
          }
        }, 1500);
      });
      pane.term.loadAddon(addon);
      pane.webgl = addon;
      this.webglCount += 1;
    } catch {
      pane.webgl = null;
    }
  }

  private releaseWebgl(pane: PaneTerminal): void {
    if (!pane.webgl) {
      return;
    }
    try {
      pane.webgl.dispose();
    } catch {
      // ignore
    }
    pane.webgl = null;
    this.webglCount = Math.max(0, this.webglCount - 1);
  }

  /** Fits the terminal to its container and syncs the pty size (debounced). */
  layout(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.opened || !pane.host.isConnected || pane.host.clientWidth < 10 || pane.host.clientHeight < 10) {
      return;
    }

    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = pane.fit.proposeDimensions();
    } catch {
      return;
    }
    if (!dims || dims.cols < 2 || dims.rows < 1 || !Number.isFinite(dims.cols)) {
      return;
    }

    if (dims.cols !== pane.term.cols || dims.rows !== pane.term.rows) {
      pane.term.resize(dims.cols, dims.rows);
    }
    this.lastKnownSize = { cols: dims.cols, rows: dims.rows };

    if (!pane.sessionId) {
      return;
    }

    const rowsOnly = dims.cols === pane.lastSent.cols;
    if (pane.resizeTimer !== null) {
      window.clearTimeout(pane.resizeTimer);
    }
    const send = () => {
      pane.resizeTimer = null;
      if (!pane.sessionId) {
        return;
      }
      const { cols, rows } = pane.term;
      if (cols === pane.lastSent.cols && rows === pane.lastSent.rows) {
        return;
      }
      pane.lastSent = { cols, rows };
      this.host.resize(pane.sessionId, cols, rows);
    };

    // Like VS Code: row changes are cheap; column changes reflow the buffer, so
    // coalesce them while the user drags a divider.
    if (rowsOnly) {
      send();
    } else {
      pane.resizeTimer = window.setTimeout(send, pane.term.buffer.normal.length > 200 ? 100 : 30);
    }
  }

  focus(paneId: string): void {
    const pane = this.panes.get(paneId);
    pane?.term.focus();
  }

  blurAll(): void {
    for (const pane of this.panes.values()) {
      this.releaseKeys(pane);
    }
  }

  /** Sends key-ups for everything still held, so no modifier sticks once focus leaves the terminal. */
  private releaseKeys(pane: PaneTerminal): void {
    if (!pane.win32) {
      return;
    }
    const release = pane.encoder.releaseAll();
    if (release && pane.sessionId) {
      this.host.input(pane.sessionId, release);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  applySettings(settings: LookoutSettings, profileOf: (paneId: string) => ProfileDefinition | undefined): void {
    const previousUnicode = this.settings?.terminal.unicodeVersion;
    this.settings = settings;
    for (const pane of this.panes.values()) {
      pane.profile = profileOf(pane.paneId) ?? pane.profile;
      const options = this.baseOptions(pane.profile, pane.fontDelta);
      for (const [key, value] of Object.entries(options)) {
        if (key === 'windowsPty' || key === 'allowProposedApi') {
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pane.term.options as any)[key] = value;
      }
      if (previousUnicode !== settings.terminal.unicodeVersion) {
        pane.term.unicode.activeVersion = settings.terminal.unicodeVersion === 'graphemes' ? '15-graphemes' : '11';
      }
      if (settings.terminal.gpuAcceleration === 'off') {
        this.releaseWebgl(pane);
      } else if (pane.host.isConnected) {
        this.enableWebgl(pane);
      }
      this.layout(pane.paneId);
    }
  }

  changeFontSize(paneId: string, delta: number | 'reset'): void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }
    pane.fontDelta = delta === 'reset' ? 0 : Math.max(-6, Math.min(40, pane.fontDelta + delta));
    const font = { ...this.settings.font, ...pane.profile?.font };
    pane.term.options.fontSize = Math.max(6, Math.min(72, font.size + pane.fontDelta));
    this.layout(paneId);
  }

  // ---------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------

  hasSelection(paneId: string): boolean {
    return Boolean(this.panes.get(paneId)?.term.hasSelection());
  }

  async copySelection(paneId: string, clear = true): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.term.hasSelection()) {
      return false;
    }

    let text = pane.term.getSelection();
    if (this.settings.terminal.trimTrailingWhitespace) {
      text = text
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n');
    }
    text = text.replace(/\r?\n/g, '\r\n');

    try {
      if (this.settings.terminal.copyFormatting && typeof ClipboardItem !== 'undefined') {
        const html = pane.serialize.serializeAsHTML({ onlySelection: true, includeGlobalBackground: true });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      return false;
    }

    if (clear) {
      pane.term.clearSelection();
    }
    return true;
  }

  async paste(paneId: string, provided?: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }

    let text = provided;
    if (text === undefined) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = '';
      }
    }

    if (!text) {
      // No text (e.g. an image): forward a literal Ctrl+V so TUIs can read the clipboard themselves.
      this.sendInput(paneId, '\x16', true);
      return;
    }

    // Strip escape sequences so a paste can never inject terminal control codes.
    let safe = text.replace(ESCAPE_CHARS, '');
    const multiline = /\r|\n/.test(safe.replace(/(\r?\n)+$/, ''));
    const large = new Blob([safe]).size > this.settings.terminal.warnLargePasteBytes && this.settings.terminal.warnLargePasteBytes > 0;
    const needsMultilineWarning = multiline && this.settings.terminal.warnMultilinePaste && !pane.term.modes.bracketedPasteMode;

    if (needsMultilineWarning || large) {
      const confirmed = await this.hooks.confirmPaste(paneId, safe, needsMultilineWarning && large ? 'both' : large ? 'large' : 'multiline');
      if (confirmed === null) {
        return;
      }
      safe = confirmed;
    }

    pane.term.paste(preparePaste(safe, this.settings.terminal.autoSubmitSingleLinePaste));
    pane.term.focus();
  }

  selectAll(paneId: string): void {
    this.panes.get(paneId)?.term.selectAll();
  }

  clear(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return;
    }
    pane.term.clear();
    // Ask the shell to redraw its prompt (Ctrl+L) when nothing is running.
    const runtime = getState().runtime[paneId];
    if (pane.sessionId && runtime && !runtime.commandRunning && pane.term.buffer.active.type === 'normal') {
      this.host.input(pane.sessionId, pane.win32 ? '\x1b[76;38;12;1;8;1_\x1b[76;38;12;0;8;1_' : '\x0c');
    }
  }

  private handleContextMenu(pane: PaneTerminal, event: MouseEvent): void {
    event.preventDefault();
    const mouseApp = pane.term.modes.mouseTrackingMode !== 'none';
    if (event.shiftKey || this.settings.terminal.rightClick === 'menu') {
      this.hooks.openContextMenu(pane.paneId, event.clientX, event.clientY);
      return;
    }
    if (mouseApp) {
      return;
    }
    if (pane.term.hasSelection()) {
      void this.copySelection(pane.paneId);
    } else {
      void this.paste(pane.paneId);
    }
  }

  // ---------------------------------------------------------------------------
  // Scrolling & command navigation
  // ---------------------------------------------------------------------------

  scroll(paneId: string, kind: 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'top' | 'bottom'): void {
    const term = this.panes.get(paneId)?.term;
    if (!term) {
      return;
    }
    switch (kind) {
      case 'lineUp':
        term.scrollLines(-1);
        break;
      case 'lineDown':
        term.scrollLines(1);
        break;
      case 'pageUp':
        term.scrollPages(-1);
        break;
      case 'pageDown':
        term.scrollPages(1);
        break;
      case 'top':
        term.scrollToTop();
        break;
      case 'bottom':
        term.scrollToBottom();
        break;
    }
  }

  /** Jumps to the previous/next command prompt. Returns false when unavailable (lets the key through). */
  jumpToCommand(paneId: string, direction: -1 | 1): boolean {
    const pane = this.panes.get(paneId);
    if (!pane || pane.term.buffer.active.type !== 'normal') {
      return false;
    }

    const lines = pane.commands.map((record) => record.prompt.line).filter((line) => line >= 0);
    if (!lines.length) {
      return false;
    }

    const top = pane.term.buffer.active.viewportY;
    const target = direction < 0 ? [...lines].reverse().find((line) => line < top) : lines.find((line) => line > top);
    if (target === undefined) {
      if (direction > 0) {
        pane.term.scrollToBottom();
        return true;
      }
      return true;
    }
    pane.term.scrollToLine(target);
    return true;
  }

  private lastCompleted(pane: PaneTerminal): CommandRecord | undefined {
    return [...pane.commands].reverse().find((record) => record.output && record.end && record.output.line >= 0 && record.end.line >= 0);
  }

  outputOf(paneId: string, record?: CommandRecord): string | null {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return null;
    }
    const target = record ?? this.lastCompleted(pane);
    if (!target?.output || !target.end) {
      return null;
    }

    const buffer = pane.term.buffer.active;
    let text = '';
    for (let line = target.output.line; line < target.end.line; line += 1) {
      const bufferLine = buffer.getLine(line);
      if (!bufferLine) {
        continue;
      }
      const next = buffer.getLine(line + 1);
      text += bufferLine.translateToString(!next?.isWrapped);
      if (!next?.isWrapped) {
        text += '\n';
      }
    }
    return text.replace(/\n+$/, '');
  }

  async copyLastOutput(paneId: string): Promise<boolean> {
    const output = this.outputOf(paneId);
    if (output === null) {
      return false;
    }
    await navigator.clipboard.writeText(output.replace(/\n/g, '\r\n'));
    return true;
  }

  selectLastOutput(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    const record = pane ? this.lastCompleted(pane) : undefined;
    if (!pane || !record?.output || !record.end) {
      return false;
    }
    pane.term.selectLines(record.output.line, Math.max(record.output.line, record.end.line - 1));
    return true;
  }

  private updateSticky(pane: PaneTerminal): void {
    if (!pane.stickyListeners.size) {
      return;
    }

    const buffer = pane.term.buffer.active;
    let sticky: StickyCommand | null = null;
    if (buffer.type === 'normal' && buffer.viewportY < buffer.baseY) {
      const top = buffer.viewportY;
      for (let index = pane.commands.length - 1; index >= 0; index -= 1) {
        const record = pane.commands[index];
        if (record.prompt.line < 0 || record.prompt.line >= top) {
          continue;
        }
        const endLine = record.end?.line ?? Number.POSITIVE_INFINITY;
        if (record.command && endLine > top) {
          sticky = { command: record.command, exitCode: record.exitCode, running: !record.end, promptLine: record.prompt.line };
        }
        break;
      }
    }

    const key = sticky ? `${sticky.promptLine}|${sticky.exitCode}|${sticky.running}` : '';
    if (key === pane.lastSticky) {
      return;
    }
    pane.lastSticky = key;
    pane.stickyListeners.forEach((listener) => listener(sticky));
  }

  onSticky(paneId: string, listener: (sticky: StickyCommand | null) => void): () => void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return () => {};
    }
    pane.stickyListeners.add(listener);
    return () => pane.stickyListeners.delete(listener);
  }

  onBellFlash(paneId: string, listener: () => void): () => void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return () => {};
    }
    pane.bellListeners.add(listener);
    return () => pane.bellListeners.delete(listener);
  }

  scrollToLine(paneId: string, line: number): void {
    this.panes.get(paneId)?.term.scrollToLine(line);
  }

  // ---------------------------------------------------------------------------
  // Find
  // ---------------------------------------------------------------------------

  find(paneId: string, query: string, options: { regex: boolean; caseSensitive: boolean; wholeWord: boolean }, direction: 1 | -1, incremental = false): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return false;
    }
    if (!query) {
      pane.search.clearDecorations();
      pane.findListeners.forEach((listener) => listener({ resultIndex: -1, resultCount: 0 }));
      return false;
    }

    const searchOptions: ISearchOptions = {
      ...options,
      incremental,
      decorations: {
        matchBackground: '#f0883e33',
        matchBorder: '#f0883e66',
        matchOverviewRuler: '#f0883e99',
        activeMatchBackground: '#f0883e88',
        activeMatchBorder: '#f0883e',
        activeMatchColorOverviewRuler: '#f0883e',
      },
    };
    try {
      return direction > 0 ? pane.search.findNext(query, searchOptions) : pane.search.findPrevious(query, searchOptions);
    } catch {
      return false;
    }
  }

  clearFind(paneId: string): void {
    const pane = this.panes.get(paneId);
    pane?.search.clearDecorations();
    pane?.term.clearSelection();
  }

  onFindResults(paneId: string, listener: (state: FindState) => void): () => void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return () => {};
    }
    pane.findListeners.add(listener);
    return () => pane.findListeners.delete(listener);
  }

  /** Serialized screen + scrollback, e.g. for "duplicate tab". */
  snapshot(paneId: string): string {
    return this.panes.get(paneId)?.serialize.serialize({ scrollback: 2000 }) ?? '';
  }

  /** Current grid size, e.g. for the size badge while a divider is dragged. */
  dimensions(paneId: string): { cols: number; rows: number } | null {
    const term = this.panes.get(paneId)?.term;
    return term ? { cols: term.cols, rows: term.rows } : null;
  }

  /** Plain text of the whole buffer (used by automated UI tests). */
  bufferText(paneId: string): string {
    const term = this.panes.get(paneId)?.term;
    if (!term) {
      return '';
    }
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  debugInfo(paneId: string): { win32: boolean; sessionId?: string; commands: number; webgl: boolean; cols: number; rows: number; bracketedPaste: boolean } | null {
    const pane = this.panes.get(paneId);
    return pane
      ? {
          win32: pane.win32,
          sessionId: pane.sessionId,
          commands: pane.commands.length,
          webgl: Boolean(pane.webgl),
          cols: pane.term.cols,
          rows: pane.term.rows,
          bracketedPaste: pane.term.modes.bracketedPasteMode,
        }
      : null;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) {
    return `${minutes}m ${rest}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const terminals = new TerminalManager();

export function initRuntime(paneId: string, kind: 'shell' | 'handoff' = 'shell', patch: Partial<PaneRuntime> = {}): void {
  setState((state) => (state.runtime[paneId] ? state : { runtime: { ...state.runtime, [paneId]: { ...createRuntime(kind), ...patch } } }));
}
