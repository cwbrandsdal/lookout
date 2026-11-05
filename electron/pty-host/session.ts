// One shell (or handed-off console) owned by the pty host: the pty, a headless
// xterm mirror for exact snapshots, output batching, ack-based flow control
// and ownership by a window port.

import * as headlessModule from '@xterm/headless';
import * as serializeModule from '@xterm/addon-serialize';
import * as unicode11Module from '@xterm/addon-unicode11';
import type { ISerializeOptions } from '@xterm/addon-serialize';
import type { Terminal as HeadlessTerminalType } from '@xterm/headless';
import { FLOW_HIGH_WATERMARK, FLOW_LOW_WATERMARK } from '../../src/shared/host-protocol';
import type { HostToRenderer, SessionInfo } from '../../src/shared/host-protocol';
import type { PtyLike } from '../../src/shared/pty';
import type { ShellKind } from '../../src/shared/settings';

export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

/** Where a session's output goes: the owning window's MessagePort. */
export interface OutputPort {
  post(message: HostToRenderer): void;
}

/** Flush batched output after this long... */
export const OUTPUT_FLUSH_MS = 4;
/** ...or once this many characters are pending. */
export const OUTPUT_FLUSH_CHARS = 256 * 1024;
// The mirror parses asynchronously; xterm discards writes above 50 MB pending.
const MIRROR_HIGH_WATERMARK = 2_000_000;
const MIRROR_LOW_WATERMARK = 200_000;
// ConPTY can drop input on very large single writes (big pastes): pace them.
const INPUT_CHUNK_CHARS = 4096;
// If a killed pty never reports exit, report it ourselves.
const KILL_EXIT_GRACE_MS = 5_000;
const MAX_DIMENSION = 32767;

// The xterm bundles are webpack CJS: esbuild sees their named exports, Node's
// ESM loader (vitest) only sees `default`.
function cjsInterop<T extends object>(namespace: T, probe: keyof T): T {
  if (typeof namespace[probe] === 'function') {
    return namespace;
  }
  const fallback = (namespace as unknown as { default?: unknown }).default;
  return (fallback && typeof fallback === 'object' ? fallback : namespace) as T;
}

/** The `@xterm/headless` Terminal constructor (CJS/ESM safe). */
export const HeadlessTerminal = cjsInterop(headlessModule, 'Terminal').Terminal;
/** The `@xterm/addon-serialize` SerializeAddon constructor (CJS/ESM safe). */
export const SerializeAddon = cjsInterop(serializeModule, 'SerializeAddon').SerializeAddon;
/** Same character widths as the renderer (which uses Unicode 11 by default). */
const Unicode11Addon = cjsInterop(unicode11Module, 'Unicode11Addon').Unicode11Addon;

type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

export function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export interface SessionOptions {
  id: string;
  kind: 'shell' | 'handoff';
  pty: PtyLike;
  paneId: string | null;
  shellKind: ShellKind;
  integrated: boolean;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: number;
  /** Windows build for xterm's ConPTY reflow heuristics (0 = unknown). */
  windowsBuild: number;
  title?: string;
  commandLine?: string;
  createdAt?: string;
  killTree: (pid: number) => Promise<void>;
  log: Logger;
  /**
   * The pty exited and the exit has been reported to the attached port, if
   * any. The host drops attached sessions and keeps detached ones listed.
   */
  onExit: (session: Session) => void;
}

interface PendingAttach {
  port: OutputPort;
  requestId: string;
  /** Size requested by the attaching renderer; applied after the snapshot. */
  cols: number;
  rows: number;
  /** Output that arrived after the snapshot point. */
  buffer: string;
}

export class Session {
  readonly id: string;
  readonly kind: 'shell' | 'handoff';
  readonly pty: PtyLike;
  readonly shellKind: ShellKind;
  readonly integrated: boolean;
  readonly cwd: string;
  readonly createdAt: string;
  readonly title: string | undefined;
  readonly commandLine: string | undefined;
  paneId: string | null;
  /** Window that owns the session (kept after that window disconnects without killing). */
  ownerWindowId: string | null = null;
  exited = false;
  exitCode: number | undefined;

  private port: OutputPort | null = null;
  private pendingAttach: PendingAttach | null = null;
  private disposed = false;
  private readonly terminal: HeadlessTerminalType;
  private readonly serializer: SerializeAddonInstance;
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly mirrorWaiters = new Set<() => void>();
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly log: Logger;
  private readonly onExitCallback: (session: Session) => void;

  private output = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inputQueue: string[] = [];
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private killPromise: Promise<void> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  // Flow control. `unacked` counts characters posted to the port but not yet acked.
  private unacked = 0;
  private rendererPaused = false;
  private mirrorPending = 0;
  private mirrorPaused = false;
  private ptyPaused = false;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.pty = options.pty;
    this.paneId = options.paneId;
    this.shellKind = options.shellKind;
    this.integrated = options.integrated;
    this.cwd = options.cwd;
    this.title = options.title;
    this.commandLine = options.commandLine;
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.killTree = options.killTree;
    this.log = options.log;
    this.onExitCallback = options.onExit;

    this.terminal = new HeadlessTerminal({
      cols: isValidDimension(options.cols) ? options.cols : 80,
      rows: isValidDimension(options.rows) ? options.rows : 24,
      scrollback: Math.max(0, Math.floor(options.scrollback)),
      allowProposedApi: true,
      logLevel: 'off',
      ...(options.windowsBuild > 0 ? { windowsPty: { backend: 'conpty' as const, buildNumber: options.windowsBuild } } : {}),
    });
    this.serializer = new SerializeAddon();
    // The serialize addon is typed against @xterm/xterm's Terminal; headless is API compatible.
    this.terminal.loadAddon(this.serializer as unknown as Parameters<HeadlessTerminalType['loadAddon']>[0]);
    try {
      this.terminal.loadAddon(new Unicode11Addon() as unknown as Parameters<HeadlessTerminalType['loadAddon']>[0]);
      this.terminal.unicode.activeVersion = '11';
    } catch (error) {
      this.log('warn', `Unicode 11 widths unavailable in the mirror: ${describeError(error)}`);
    }

    // Answers to terminal queries (DA1, DSR, ...). The attached renderer's xterm
    // answers them itself, so the mirror only speaks while nobody is attached.
    // node-pty's bundled ConPTY blocks shell startup until DA1 is answered.
    this.subscriptions.push(this.terminal.onData((reply) => {
      if (!this.port && !this.exited && !this.disposed) {
        this.writePty(reply);
      }
    }));
    this.subscriptions.push(this.pty.onData((data) => this.guard('pty data', () => this.handlePtyData(data))));
    this.subscriptions.push(this.pty.onExit((event) => this.guard('pty exit', () => this.handlePtyExit(event?.exitCode))));
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** True while output streams to a port (including during an attach snapshot). */
  get attached(): boolean {
    return this.port !== null;
  }

  isAttachedTo(port: OutputPort): boolean {
    return this.port === port;
  }

  /** @internal Flow-control state, for tests and diagnostics. */
  get flowState(): { unacked: number; paused: boolean; mirrorPending: number } {
    return { unacked: this.unacked, paused: this.ptyPaused, mirrorPending: this.mirrorPending };
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      paneId: this.paneId,
      kind: this.kind,
      pid: this.pty.pid,
      shellKind: this.shellKind,
      integrated: this.integrated,
      cwd: this.cwd,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      ...(this.title !== undefined ? { title: this.title } : {}),
      ...(this.commandLine !== undefined ? { commandLine: this.commandLine } : {}),
      createdAt: this.createdAt,
      exited: this.exited,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
    };
  }

  /**
   * Seeds the mirror with scrollback the renderer restored before this shell
   * started (session restore), so later snapshots (reload, tab moved to another
   * window) still contain it. Must run before any pty output.
   */
  primeMirror(data: string): void {
    this.writeMirror(data, () => {});
  }

  /** Streams to `port` from the start (the session was created over it; no snapshot needed). */
  attachNew(port: OutputPort, windowId: string): void {
    this.ownerWindowId = windowId;
    this.port = port;
    this.resetFlow();
  }

  /**
   * Transfers ownership to `port` and replies `attach-result` with an exact
   * snapshot. Output that arrives before the snapshot point is in the
   * snapshot; output after it is buffered and posted right after the result.
   */
  attach(port: OutputPort, windowId: string, paneId: string | null, requestId: string, cols: number, rows: number): void {
    if (this.disposed) {
      this.safePost(port, { type: 'attach-result', requestId, ok: false, error: 'The session has closed' });
      return;
    }
    const superseded = this.pendingAttach;
    if (superseded) {
      this.safePost(superseded.port, {
        type: 'attach-result',
        requestId: superseded.requestId,
        ok: false,
        error: 'The session was attached again before the snapshot completed',
      });
    }
    // Unflushed output is already in the mirror, hence in the snapshot.
    this.dropOutput();
    this.ownerWindowId = windowId;
    if (paneId !== null) {
      this.paneId = paneId;
    }
    this.port = port;
    this.resetFlow();

    const token: PendingAttach = {
      port,
      requestId,
      cols: isValidDimension(cols) ? cols : this.terminal.cols,
      rows: isValidDimension(rows) ? rows : this.terminal.rows,
      buffer: '',
    };
    this.pendingAttach = token;
    // Callbacks run in write order: everything written before this point has
    // been parsed when it fires, nothing written after it has.
    this.writeMirror('', () => this.guard('attach snapshot', () => this.completeAttach(token)));
  }

  /** Stops streaming (port replaced, closed or window gone). The pty keeps running. */
  detach(): void {
    const abandonedAttach = this.pendingAttach !== null;
    this.dropOutput();
    this.pendingAttach = null;
    this.port = null;
    this.resetFlow();
    if (abandonedAttach && this.exited && !this.disposed) {
      // The exit was waiting for that snapshot; now it is simply kept and listed.
      this.onExitCallback(this);
    }
  }

  write(data: string): void {
    if (this.disposed || this.exited || !data) {
      return;
    }
    if (!this.inputQueue.length && data.length <= INPUT_CHUNK_CHARS) {
      this.writePty(data);
      return;
    }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + INPUT_CHUNK_CHARS, data.length);
      if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) {
        end -= 1;
      }
      this.inputQueue.push(data.slice(offset, end));
      offset = end;
    }
    this.drainInput();
  }

  /** Applies a size to the pty and the mirror. Returns false for no-ops and invalid sizes. */
  resize(cols: number, rows: number): boolean {
    if (this.disposed || !isValidDimension(cols) || !isValidDimension(rows)) {
      return false;
    }
    if (this.pendingAttach) {
      // The snapshot must be taken at the size the attach result reports.
      this.pendingAttach.cols = cols;
      this.pendingAttach.rows = rows;
      return true;
    }
    if (cols === this.terminal.cols && rows === this.terminal.rows) {
      return false;
    }
    try {
      this.terminal.resize(cols, rows);
    } catch (error) {
      this.log('warn', `Session ${this.id}: mirror resize failed: ${describeError(error)}`);
    }
    if (!this.exited) {
      try {
        this.pty.resize(cols, rows);
      } catch (error) {
        this.log('warn', `Session ${this.id}: pty resize failed: ${describeError(error)}`);
      }
    }
    return true;
  }

  ack(chars: number): void {
    if (!Number.isFinite(chars) || chars <= 0) {
      return;
    }
    this.unacked = Math.max(0, this.unacked - chars);
    this.updatePause();
  }

  setScrollback(lines: number): void {
    try {
      this.terminal.options.scrollback = lines;
    } catch (error) {
      this.log('warn', `Session ${this.id}: could not set scrollback: ${describeError(error)}`);
    }
  }

  /** Serializes the mirror once every chunk received so far has been parsed. */
  serialize(options: ISerializeOptions): Promise<string> {
    return new Promise((resolve) => {
      if (this.disposed) {
        resolve('');
        return;
      }
      const waiter = () => resolve('');
      this.mirrorWaiters.add(waiter);
      this.writeMirror('', () => {
        this.mirrorWaiters.delete(waiter);
        resolve(this.disposed ? '' : this.serializeNow(options));
      });
    });
  }

  /** Kills the process tree (dev servers etc.), then the pty. Idempotent. */
  kill(): Promise<void> {
    this.killPromise ??= (async () => {
      if (this.exited) {
        return;
      }
      try {
        await this.killTree(this.pty.pid);
      } catch (error) {
        this.log('warn', `Session ${this.id}: process tree kill failed: ${describeError(error)}`);
      }
      if (this.exited) {
        return;
      }
      try {
        this.pty.kill();
      } catch (error) {
        this.log('warn', `Session ${this.id}: pty kill failed: ${describeError(error)}`);
      }
      if (!this.exited && !this.disposed) {
        this.killTimer = setTimeout(() => {
          this.killTimer = null;
          this.guard('kill timeout', () => this.handlePtyExit(1));
        }, KILL_EXIT_GRACE_MS);
        this.killTimer.unref?.();
      }
    })();
    return this.killPromise;
  }

  /** Releases the mirror and listeners. Does not kill the pty. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    const pending = this.pendingAttach;
    this.dropOutput();
    this.pendingAttach = null;
    this.port = null;
    this.disposed = true;
    if (pending) {
      this.safePost(pending.port, { type: 'attach-result', requestId: pending.requestId, ok: false, error: 'The session has closed' });
    }
    this.clearTimer('input');
    this.clearTimer('kill');
    this.inputQueue = [];
    for (const subscription of this.subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {
        // Already disposed.
      }
    }
    for (const waiter of this.mirrorWaiters) {
      waiter();
    }
    this.mirrorWaiters.clear();
    try {
      this.serializer.dispose();
      this.terminal.dispose();
    } catch (error) {
      this.log('warn', `Session ${this.id}: mirror dispose failed: ${describeError(error)}`);
    }
  }

  // ---- internals -------------------------------------------------------------

  private handlePtyData(data: string): void {
    if (this.disposed || typeof data !== 'string' || !data) {
      return;
    }
    const length = data.length;
    this.mirrorPending += length;
    this.writeMirror(data, () => {
      this.mirrorPending -= length;
      this.updatePause();
    });

    if (this.pendingAttach) {
      this.pendingAttach.buffer += data;
    } else if (this.port) {
      this.output += data;
      if (this.output.length >= OUTPUT_FLUSH_CHARS) {
        this.flush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.guard('flush', () => this.flush()), OUTPUT_FLUSH_MS);
      }
    }
    this.updatePause();
  }

  private handlePtyExit(exitCode: unknown): void {
    if (this.exited || this.disposed) {
      return;
    }
    this.exited = true;
    this.exitCode = typeof exitCode === 'number' && Number.isFinite(exitCode) ? exitCode : 0;
    this.clearTimer('kill');
    this.clearTimer('input');
    this.inputQueue = [];
    if (this.pendingAttach) {
      // Reported after the attach result, by completeAttach.
      return;
    }
    this.flush();
    if (this.port) {
      this.safePost(this.port, { type: 'exit', sessionId: this.id, exitCode: this.exitCode });
    }
    this.onExitCallback(this);
  }

  private completeAttach(token: PendingAttach): void {
    if (this.disposed || this.pendingAttach !== token) {
      return; // Superseded, detached or closed; whoever did that has replied.
    }
    const snapshot = this.serializeNow({});
    // The mirror's size at the snapshot point, not the requested size.
    const session = this.info();
    this.pendingAttach = null;
    this.safePost(token.port, { type: 'attach-result', requestId: token.requestId, ok: true, session, snapshot });
    if (token.buffer) {
      this.send(token.port, token.buffer);
    }
    this.resize(token.cols, token.rows);
    if (this.exited) {
      this.safePost(token.port, { type: 'exit', sessionId: this.id, exitCode: this.exitCode ?? 0 });
      this.onExitCallback(this);
    }
  }

  private serializeNow(options: ISerializeOptions): string {
    try {
      return this.serializer.serialize(options);
    } catch (error) {
      this.log('error', `Session ${this.id}: serialize failed: ${describeError(error)}`);
      return '';
    }
  }

  private flush(): void {
    this.clearTimer('flush');
    if (!this.output) {
      return;
    }
    const data = this.output;
    this.output = '';
    if (this.port && !this.pendingAttach) {
      this.send(this.port, data);
    }
  }

  private send(port: OutputPort, data: string): void {
    this.safePost(port, { type: 'data', sessionId: this.id, data });
    this.unacked += data.length;
    this.updatePause();
  }

  private dropOutput(): void {
    this.clearTimer('flush');
    this.output = '';
  }

  private resetFlow(): void {
    this.unacked = 0;
    this.rendererPaused = false;
    this.updatePause();
  }

  private updatePause(): void {
    if (this.disposed) {
      return;
    }
    if (!this.rendererPaused && this.unacked > FLOW_HIGH_WATERMARK) {
      this.rendererPaused = true;
    } else if (this.rendererPaused && this.unacked < FLOW_LOW_WATERMARK) {
      this.rendererPaused = false;
    }
    if (!this.mirrorPaused && this.mirrorPending > MIRROR_HIGH_WATERMARK) {
      this.mirrorPaused = true;
    } else if (this.mirrorPaused && this.mirrorPending < MIRROR_LOW_WATERMARK) {
      this.mirrorPaused = false;
    }
    const pause = this.rendererPaused || this.mirrorPaused;
    if (pause === this.ptyPaused || this.exited) {
      return;
    }
    this.ptyPaused = pause;
    try {
      if (pause) {
        this.pty.pause?.();
      } else {
        this.pty.resume?.();
      }
    } catch (error) {
      this.log('warn', `Session ${this.id}: pty ${pause ? 'pause' : 'resume'} failed: ${describeError(error)}`);
    }
  }

  private writeMirror(data: string, callback: () => void): void {
    try {
      this.terminal.write(data, () => this.guard('mirror callback', callback));
    } catch (error) {
      this.log('error', `Session ${this.id}: mirror write failed: ${describeError(error)}`);
      callback();
    }
  }

  private writePty(data: string): void {
    try {
      this.pty.write(data);
    } catch (error) {
      this.log('warn', `Session ${this.id}: pty write failed: ${describeError(error)}`);
    }
  }

  private drainInput(): void {
    if (this.inputTimer) {
      return;
    }
    const next = (): void => {
      this.inputTimer = null;
      if (this.disposed || this.exited) {
        this.inputQueue = [];
        return;
      }
      const chunk = this.inputQueue.shift();
      if (chunk === undefined) {
        return;
      }
      this.writePty(chunk);
      if (this.inputQueue.length) {
        this.inputTimer = setTimeout(() => this.guard('input', next), 1);
      }
    };
    next();
  }

  private clearTimer(which: 'flush' | 'input' | 'kill'): void {
    const timer = which === 'flush' ? this.flushTimer : which === 'input' ? this.inputTimer : this.killTimer;
    if (timer) {
      clearTimeout(timer);
    }
    if (which === 'flush') {
      this.flushTimer = null;
    } else if (which === 'input') {
      this.inputTimer = null;
    } else {
      this.killTimer = null;
    }
  }

  private safePost(port: OutputPort, message: HostToRenderer): void {
    try {
      port.post(message);
    } catch (error) {
      this.log('warn', `Session ${this.id}: posting ${message.type} failed: ${describeError(error)}`);
    }
  }

  private guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log('error', `Session ${this.id}: ${label} failed: ${describeError(error)}`);
    }
  }
}
