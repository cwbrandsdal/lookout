// Transport-agnostic core of the pty host. `host.ts` adapts Electron's
// parentPort / MessagePortMain to it; tests drive it with fakes.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectShellKind, detectShellKindFromCommandLine, expandEnvVars, getEnv } from '../../src/shared/commandline';
import type { HostToMain, HostToRenderer, LaunchSpec, SessionInfo } from '../../src/shared/host-protocol';
import type { HandoffOffer, HandoffServer, PtyLike, ShellLaunch, ShellLaunchInput } from '../../src/shared/pty';
import { killProcessTree } from './process-tree';
import { isValidDimension, Session } from './session';
import type { LogLevel, OutputPort } from './session';

export type { LogLevel } from './session';

/** A window's MessagePort as the core sees it. */
export interface WindowPort extends OutputPort {
  post(message: HostToRenderer): void;
  onMessage(callback: (message: unknown) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty: boolean;
  useConptyDll?: boolean;
  /** PSEUDOCONSOLE_INHERIT_CURSOR: ConPTY asks the terminal for the cursor position (DSR) and starts there. */
  conptyInheritCursor?: boolean;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

export type StartHandoff = (options: {
  pipeName: string;
  onSession: (offer: HandoffOffer) => void;
  log: (message: string) => void;
}) => HandoffServer;

export interface PtyHostDeps {
  postToMain: (message: HostToMain) => void;
  spawn?: PtySpawn;
  buildLaunch?: (input: ShellLaunchInput) => ShellLaunch;
  startHandoff?: StartHandoff;
  /** Fresh system/user environment. Defaults to a copy of `process.env`. */
  readEnvironment?: () => Promise<Record<string, string>>;
  killTree?: (pid: number) => Promise<void>;
  /** Defaults to posting `log` messages to main. */
  log?: (level: LogLevel, message: string) => void;
}

interface HostConfig {
  shellIntegrationDir: string;
  handoffPipeName: string | null;
  windowsBuild: number;
  scrollback: number;
}

interface WindowConnection {
  windowId: string;
  port: WindowPort;
  closed: boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 10_000;
const MAX_SCROLLBACK = 1_000_000;
const CWD_CHECK_TIMEOUT_MS = 2_000;

type Message = Record<string, unknown>;

function isRecord(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isScrollback(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SCROLLBACK;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[name] = value;
    }
  }
  return env;
}

// Variables that describe *Lookout's* Electron runtime. Leaking them into shells
// breaks every Electron app started from the terminal (`code`, Slack, …), e.g.
// ELECTRON_RUN_AS_NODE makes them start as plain Node.
const ELECTRON_INTERNAL_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|ELECTRON_ENABLE_LOGGING|ELECTRON_ENABLE_STACK_DUMPING|ELECTRON_DEFAULT_ERROR_MODE|ELECTRON_NO_ASAR|ELECTRON_FORCE_IS_PACKAGED|CHROME_CRASHPAD_PIPE_NAME|ORIGINAL_XDG_CURRENT_DESKTOP|GOOGLE_API_KEY|VITE_DEV_SERVER_URL|LOOKOUT_TEST|LOOKOUT_USER_DATA_DIR|LOOKOUT_DEVTOOLS)$/i;

/** Removes Lookout's own runtime variables from a shell environment. */
export function scrubElectronEnvironment(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(env)) {
    if (ELECTRON_INTERNAL_ENV.test(key)) {
      delete env[key];
    }
  }
  return env;
}

/** Sets `name` case-insensitively (Windows semantics), keeping the casing already present. */
function setEnv(env: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  let target: string | undefined;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) {
      if (target === undefined) {
        target = key;
      } else {
        delete env[key];
      }
    }
  }
  env[target ?? name] = value;
}

function parseLaunch(value: unknown): LaunchSpec {
  if (!isRecord(value)) {
    throw new Error('The launch specification is missing');
  }
  if (!isNonEmptyString(value.commandline) || !value.commandline.trim()) {
    throw new Error('The profile has no command line');
  }
  const env: Record<string, string> = {};
  if (isRecord(value.env)) {
    for (const [name, entry] of Object.entries(value.env)) {
      if (name && !name.includes('=') && !name.includes('\0') && typeof entry === 'string') {
        env[name] = entry;
      }
    }
  }
  return {
    profileId: typeof value.profileId === 'string' ? value.profileId : '',
    commandline: value.commandline,
    ...(isNonEmptyString(value.startupCommand) ? { startupCommand: value.startupCommand } : {}),
    ...(isNonEmptyString(value.cwd) ? { cwd: value.cwd } : {}),
    env,
    shellIntegration: value.shellIntegration === true,
    ...(value.inheritCursor === true ? { inheritCursor: true } : {}),
    ...(typeof value.restoredBuffer === 'string' && value.restoredBuffer ? { restoredBuffer: value.restoredBuffer } : {}),
  };
}

async function isDirectory(candidate: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // An unreachable network share can block stat for a long time.
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CWD_CHECK_TIMEOUT_MS);
    });
    return await Promise.race([stat(candidate).then((info) => info.isDirectory(), () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class PtyHost {
  private readonly sessions = new Map<string, Session>();
  private readonly windows = new Map<string, WindowConnection>();
  private config: HostConfig = {
    shellIntegrationDir: '',
    handoffPipeName: null,
    windowsBuild: 0,
    scrollback: DEFAULT_SCROLLBACK,
  };
  private handoffServer: HandoffServer | null = null;
  private runningHandoffPipe: string | null = null;
  private readonly deps: PtyHostDeps;
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly readEnvironment: () => Promise<Record<string, string>>;

  constructor(deps: PtyHostDeps) {
    this.deps = deps;
    this.killTree = deps.killTree ?? killProcessTree;
    this.readEnvironment = deps.readEnvironment ?? (async () => processEnvironment());
  }

  /** Tells main the host is listening. */
  start(): void {
    this.postToMain({ type: 'ready' });
  }

  /** Closes the handoff server and kills every session. */
  async dispose(): Promise<void> {
    this.closeHandoffServer();
    for (const connection of [...this.windows.values()]) {
      this.closeConnection(connection);
    }
    await this.killSessions([...this.sessions.values()]);
  }

  /** @internal For tests and diagnostics. */
  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** @internal For tests and diagnostics. */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  handleMainMessage(message: unknown, ports: readonly WindowPort[] = []): void {
    this.guard('main message', () => this.dispatchMain(message, ports));
  }

  // ---- main -> host ----------------------------------------------------------

  private dispatchMain(message: unknown, ports: readonly WindowPort[]): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.log('warn', 'Ignoring a malformed message from main');
      this.closeUnusedPorts(ports);
      return;
    }
    switch (message.type) {
      case 'init':
        this.init(message);
        break;
      case 'connect-window':
        this.connectWindow(message, ports);
        return;
      case 'disconnect-window':
        this.disconnectWindow(message);
        break;
      case 'serialize':
        this.background('serialize', this.serialize(message));
        break;
      case 'list':
        if (typeof message.requestId === 'string') {
          this.postToMain({ type: 'list-result', requestId: message.requestId, sessions: this.mainSessionList() });
        }
        break;
      case 'kill-all':
        this.background('kill-all', this.killAll(message));
        break;
      case 'set-scrollback':
        if (isScrollback(message.scrollback)) {
          this.config.scrollback = message.scrollback;
          for (const session of this.sessions.values()) {
            session.setScrollback(message.scrollback);
          }
        }
        break;
      default:
        this.log('warn', `Ignoring unknown main message type ${JSON.stringify(message.type).slice(0, 64)}`);
    }
    this.closeUnusedPorts(ports);
  }

  private init(message: Message): void {
    if (typeof message.shellIntegrationDir !== 'string'
      || (message.handoffPipeName !== null && typeof message.handoffPipeName !== 'string')) {
      this.log('warn', 'Ignoring a malformed init message');
      return;
    }
    this.config = {
      shellIntegrationDir: message.shellIntegrationDir,
      handoffPipeName: isNonEmptyString(message.handoffPipeName) ? message.handoffPipeName : null,
      windowsBuild: typeof message.windowsBuild === 'number' && Number.isInteger(message.windowsBuild) && message.windowsBuild > 0
        ? message.windowsBuild
        : this.config.windowsBuild,
      scrollback: isScrollback(message.scrollback) ? message.scrollback : this.config.scrollback,
    };
    for (const session of this.sessions.values()) {
      session.setScrollback(this.config.scrollback);
    }
    this.startHandoffServer();
  }

  private startHandoffServer(): void {
    const pipeName = this.config.handoffPipeName;
    if (this.handoffServer && this.runningHandoffPipe === pipeName) {
      return;
    }
    this.closeHandoffServer();
    if (!pipeName) {
      return;
    }
    if (!this.deps.startHandoff) {
      this.log('warn', 'Default-terminal handoff is not available in this build');
      return;
    }
    try {
      this.handoffServer = this.deps.startHandoff({
        pipeName,
        onSession: (offer) => this.guard('handoff', () => this.acceptHandoff(offer)),
        log: (text) => this.log('info', text),
      });
      this.runningHandoffPipe = pipeName;
    } catch (error) {
      this.log('error', `Could not start the handoff server on ${pipeName}: ${describeError(error)}`);
    }
  }

  private closeHandoffServer(): void {
    const server = this.handoffServer;
    this.handoffServer = null;
    this.runningHandoffPipe = null;
    if (server) {
      try {
        server.close();
      } catch (error) {
        this.log('warn', `Closing the handoff server failed: ${describeError(error)}`);
      }
    }
  }

  private connectWindow(message: Message, ports: readonly WindowPort[]): void {
    const [port, ...extra] = ports;
    this.closeUnusedPorts(extra);
    if (!isNonEmptyString(message.windowId) || !port) {
      this.log('warn', 'Ignoring connect-window without a window id and port');
      if (port) {
        this.closePort(port);
      }
      return;
    }
    const windowId = message.windowId;
    const previous = this.windows.get(windowId);
    if (previous) {
      // Renderer reload: its sessions keep running and wait for `attach`.
      this.closeConnection(previous);
    }
    const connection: WindowConnection = { windowId, port, closed: false };
    this.windows.set(windowId, connection);
    port.onMessage((data) => {
      if (!connection.closed) {
        this.guard('renderer message', () => this.dispatchRenderer(connection, data));
      }
    });
    port.onClose(() => {
      if (!connection.closed) {
        this.guard('port close', () => this.closeConnection(connection));
      }
    });
  }

  private disconnectWindow(message: Message): void {
    if (!isNonEmptyString(message.windowId)) {
      this.log('warn', 'Ignoring disconnect-window without a window id');
      return;
    }
    const windowId = message.windowId;
    const connection = this.windows.get(windowId);
    if (connection) {
      this.closeConnection(connection);
    }
    if (message.killSessions === true) {
      this.background('disconnect-window', this.killSessions([...this.sessions.values()].filter((session) => session.ownerWindowId === windowId)));
    }
  }

  private async serialize(message: Message): Promise<void> {
    if (typeof message.requestId !== 'string') {
      return;
    }
    const requestId = message.requestId;
    const scrollback = isScrollback(message.scrollbackLines) ? message.scrollbackLines : this.config.scrollback;
    const sessions = [...this.sessions.values()];
    const buffers = await Promise.all(sessions.map(async (session) => ({
      sessionId: session.id,
      paneId: session.paneId,
      ownerWindowId: session.ownerWindowId,
      data: await session.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true }).catch(() => ''),
    })));
    this.postToMain({ type: 'serialize-result', requestId, buffers });
  }

  private async killAll(message: Message): Promise<void> {
    if (typeof message.requestId !== 'string') {
      this.log('warn', 'Ignoring kill-all without a request id');
      return;
    }
    const requestId = message.requestId;
    await this.killSessions([...this.sessions.values()]);
    this.postToMain({ type: 'kill-all-result', requestId });
  }

  private mainSessionList(): Array<SessionInfo & { ownerWindowId: string | null }> {
    return [...this.sessions.values()].map((session) => ({ ...session.info(), ownerWindowId: session.ownerWindowId }));
  }

  // ---- renderer -> host ------------------------------------------------------

  private dispatchRenderer(connection: WindowConnection, message: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.log('warn', `Ignoring a malformed message from window ${connection.windowId}`);
      return;
    }
    switch (message.type) {
      case 'create':
        this.background('create', this.create(connection, message));
        break;
      case 'attach':
        this.attach(connection, message);
        break;
      case 'input': {
        const session = this.attachedSession(connection, message.sessionId);
        if (session && typeof message.data === 'string') {
          session.write(message.data);
        }
        break;
      }
      case 'resize': {
        const session = this.attachedSession(connection, message.sessionId);
        if (session && isValidDimension(message.cols) && isValidDimension(message.rows)) {
          session.resize(message.cols, message.rows);
        }
        break;
      }
      case 'ack': {
        const session = this.attachedSession(connection, message.sessionId);
        if (session && typeof message.chars === 'number') {
          session.ack(message.chars);
        }
        break;
      }
      case 'kill': {
        const session = typeof message.sessionId === 'string' ? this.sessions.get(message.sessionId) : undefined;
        // Only the owner may kill: a window that lost a tab must not kill it.
        if (session && session.ownerWindowId === connection.windowId) {
          this.background('kill', session.kill());
        }
        break;
      }
      case 'list':
        if (typeof message.requestId === 'string') {
          this.rendererList(connection, message.requestId);
        }
        break;
      default:
        this.log('warn', `Ignoring unknown message type ${JSON.stringify(message.type).slice(0, 64)} from window ${connection.windowId}`);
    }
  }

  private async create(connection: WindowConnection, message: Message): Promise<void> {
    if (typeof message.requestId !== 'string') {
      this.log('warn', 'Ignoring create without a request id');
      return;
    }
    const requestId = message.requestId;
    let pty: PtyLike | null = null;
    try {
      if (!isNonEmptyString(message.paneId)) {
        throw new Error('A pane id is required');
      }
      const paneId = message.paneId;
      const launch = parseLaunch(message.launch);
      const cols = isValidDimension(message.cols) ? message.cols : DEFAULT_COLS;
      const rows = isValidDimension(message.rows) ? message.rows : DEFAULT_ROWS;
      const { spawn, buildLaunch } = this.deps;
      if (!spawn || !buildLaunch) {
        throw new Error('The pty host has no shell launcher');
      }
      const sessionId = randomUUID();

      const fresh = await this.readEnvironment().catch((error: unknown) => {
        this.log('warn', `Using the process environment: ${describeError(error)}`);
        return processEnvironment();
      });
      const cwd = await this.resolveCwd(launch.cwd, fresh);
      const env = scrubElectronEnvironment({ ...fresh });
      for (const [name, value] of Object.entries(launch.env ?? {})) {
        setEnv(env, name, value);
      }
      setEnv(env, 'LOOKOUT_PANE_ID', paneId);
      setEnv(env, 'LOOKOUT_SESSION_ID', sessionId);
      setEnv(env, 'LOOKOUT_WINDOW_ID', connection.windowId);

      if (connection.closed) {
        // The renderer reloaded or closed meanwhile; nobody would ever see this shell.
        this.log('info', `Not starting a shell for pane ${paneId}: window ${connection.windowId} went away`);
        return;
      }
      const shellIntegration = launch.shellIntegration && this.config.shellIntegrationDir !== '';
      const shell = buildLaunch({
        commandline: launch.commandline,
        ...(launch.startupCommand !== undefined ? { startupCommand: launch.startupCommand } : {}),
        cwd,
        shellIntegration,
        shellIntegrationDir: this.config.shellIntegrationDir,
        env,
      });
      pty = this.spawnPty(spawn, shell, cwd, cols, rows, launch.inheritCursor === true);
      const session = new Session({
        id: sessionId,
        kind: 'shell',
        pty,
        paneId,
        shellKind: shell.shellKind,
        integrated: shell.integrated,
        cwd,
        cols,
        rows,
        scrollback: this.config.scrollback,
        windowsBuild: this.config.windowsBuild,
        commandLine: launch.commandline,
        killTree: this.killTree,
        log: (level, text) => this.log(level, text),
        onExit: (exited) => this.handleSessionExit(exited),
      });
      pty = null;
      if (launch.restoredBuffer) {
        session.primeMirror(launch.restoredBuffer);
      }
      this.sessions.set(sessionId, session);
      session.attachNew(connection.port, connection.windowId);
      this.postToPort(connection.port, { type: 'create-result', requestId, ok: true, session: session.info() });
    } catch (error) {
      if (pty) {
        const orphan = pty;
        void this.killTree(orphan.pid).finally(() => {
          try {
            orphan.kill();
          } catch {
            // Already gone.
          }
        });
      }
      this.postToPort(connection.port, { type: 'create-result', requestId, ok: false, error: describeError(error) });
    }
  }

  private spawnPty(spawn: PtySpawn, shell: ShellLaunch, cwd: string, cols: number, rows: number, inheritCursor = false): PtyLike {
    const options: PtySpawnOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: shell.env,
      useConpty: true,
      ...(inheritCursor ? { conptyInheritCursor: true } : {}),
    };
    try {
      // node-pty's bundled ConPTY (OpenConsole) is what Windows Terminal ships.
      return spawn(shell.file, shell.args, { ...options, useConptyDll: true });
    } catch (error) {
      this.log('warn', `Bundled ConPTY failed (${describeError(error)}); retrying with the inbox ConPTY`);
      return spawn(shell.file, shell.args, options);
    }
  }

  private async resolveCwd(requested: string | undefined, env: Record<string, string>): Promise<string> {
    const candidates = [
      requested ? expandEnvVars(requested.trim(), env) : undefined,
      getEnv(env, 'USERPROFILE'),
      os.homedir(),
    ];
    for (const candidate of candidates) {
      if (candidate && path.isAbsolute(candidate) && await isDirectory(candidate)) {
        return path.resolve(candidate);
      }
    }
    return process.cwd();
  }

  private attach(connection: WindowConnection, message: Message): void {
    if (typeof message.requestId !== 'string') {
      this.log('warn', 'Ignoring attach without a request id');
      return;
    }
    const requestId = message.requestId;
    const session = typeof message.sessionId === 'string' ? this.sessions.get(message.sessionId) : undefined;
    if (!session) {
      this.postToPort(connection.port, { type: 'attach-result', requestId, ok: false, error: 'The session no longer exists' });
      return;
    }
    session.attach(
      connection.port,
      connection.windowId,
      isNonEmptyString(message.paneId) ? message.paneId : null,
      requestId,
      isValidDimension(message.cols) ? message.cols : session.cols,
      isValidDimension(message.rows) ? message.rows : session.rows,
    );
  }

  private rendererList(connection: WindowConnection, requestId: string): void {
    const owned = [...this.sessions.values()].filter((session) => session.ownerWindowId === connection.windowId);
    this.postToPort(connection.port, { type: 'list-result', requestId, sessions: owned.map((session) => session.info()) });
    // The window has now seen these exits.
    for (const session of owned) {
      if (session.exited) {
        this.removeSession(session);
      }
    }
  }

  private attachedSession(connection: WindowConnection, sessionId: unknown): Session | undefined {
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    return session?.isAttachedTo(connection.port) ? session : undefined;
  }

  // ---- sessions ----------------------------------------------------------------

  private acceptHandoff(offer: HandoffOffer): void {
    const pty = offer?.pty;
    if (!pty || typeof pty.onData !== 'function' || typeof pty.onExit !== 'function'
      || typeof pty.write !== 'function' || typeof pty.kill !== 'function') {
      this.log('warn', 'Ignoring an invalid handoff offer');
      return;
    }
    const title = typeof offer.title === 'string' ? offer.title : undefined;
    const commandLine = typeof offer.commandLine === 'string' ? offer.commandLine : undefined;
    const shellKind = commandLine ? detectShellKindFromCommandLine(commandLine) : title ? detectShellKind(title) : 'other';
    const sessionId = randomUUID();
    const session = new Session({
      id: sessionId,
      kind: 'handoff',
      pty,
      paneId: null,
      shellKind,
      integrated: false,
      cwd: typeof offer.cwd === 'string' ? offer.cwd : '',
      cols: isValidDimension(offer.cols) ? offer.cols : DEFAULT_COLS,
      rows: isValidDimension(offer.rows) ? offer.rows : DEFAULT_ROWS,
      scrollback: this.config.scrollback,
      windowsBuild: this.config.windowsBuild,
      ...(title !== undefined ? { title } : {}),
      ...(commandLine !== undefined ? { commandLine } : {}),
      killTree: this.killTree,
      log: (level, text) => this.log(level, text),
      onExit: (exited) => this.handleSessionExit(exited),
    });
    this.sessions.set(sessionId, session);
    this.postToMain({ type: 'handoff-arrived', session: session.info() });
  }

  private handleSessionExit(session: Session): void {
    // Reported to an attached owner: done. Otherwise keep it listed as exited
    // until a window attaches to it or lists it.
    if (session.attached) {
      this.removeSession(session);
    }
  }

  private removeSession(session: Session): void {
    if (this.sessions.get(session.id) === session) {
      this.sessions.delete(session.id);
    }
    session.dispose();
  }

  private async killSessions(sessions: Session[]): Promise<void> {
    const kills = sessions.map((session) => {
      const killed = session.kill();
      this.removeSession(session);
      return killed;
    });
    await Promise.allSettled(kills);
  }

  private closeConnection(connection: WindowConnection): void {
    connection.closed = true;
    if (this.windows.get(connection.windowId) === connection) {
      this.windows.delete(connection.windowId);
    }
    for (const session of [...this.sessions.values()]) {
      if (session.isAttachedTo(connection.port)) {
        session.detach();
      }
    }
    this.closePort(connection.port);
  }

  // ---- plumbing ----------------------------------------------------------------

  private closeUnusedPorts(ports: readonly WindowPort[]): void {
    for (const port of ports) {
      this.closePort(port);
    }
  }

  private closePort(port: WindowPort): void {
    try {
      port.close();
    } catch {
      // Already closed.
    }
  }

  private postToPort(port: WindowPort, message: HostToRenderer): void {
    try {
      port.post(message);
    } catch (error) {
      this.log('warn', `Posting ${message.type} to a window failed: ${describeError(error)}`);
    }
  }

  private postToMain(message: HostToMain): void {
    try {
      this.deps.postToMain(message);
    } catch {
      // Main is gone; nothing useful left to do with the message.
    }
  }

  private log(level: LogLevel, message: string): void {
    try {
      if (this.deps.log) {
        this.deps.log(level, message);
      } else {
        this.deps.postToMain({ type: 'log', level, message });
      }
    } catch {
      // Logging must never throw.
    }
  }

  private guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log('error', `Pty host ${label} failed: ${describeError(error)}`);
    }
  }

  private background(label: string, work: Promise<unknown>): void {
    work.catch((error: unknown) => this.log('error', `Pty host ${label} failed: ${describeError(error)}`));
  }
}
