import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { splitCommandLine } from '../../src/shared/commandline';
import { FLOW_ACK_BATCH } from '../../src/shared/host-protocol';
import type { HostToMain, HostToRenderer, SessionInfo } from '../../src/shared/host-protocol';
import type { PtyLike } from '../../src/shared/pty';
import { FreshEnvironment } from './environment';
import { PtyHost } from './host-core';
import type { WindowPort } from './host-core';
import { HeadlessTerminal } from './session';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const windows = process.platform === 'win32';
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const CMD = `${path.join(system32, 'cmd.exe')} /d /q`;
const DA1_QUERY = '\x1b[c';
const DA1_REPLY = '\x1b[?1;2c';

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Emulates a window's renderer: a real xterm parses the stream, answers
 * terminal queries (DA1) as input and acks parsed data in FLOW_ACK_BATCH
 * steps, exactly like `terminal.write(data, callback)` in production.
 * Messages are delivered asynchronously, like a MessagePort.
 */
class RendererEmulator implements WindowPort {
  readonly term = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 50_000, allowProposedApi: true, logLevel: 'off' });
  readonly messages: HostToRenderer[] = [];
  readonly inputs: string[] = [];
  raw = '';
  sessionId: string | null = null;
  exitCode: number | null = null;
  holdAcks = false;
  closed = false;
  private parsedUnacked = 0;
  private messageListener: ((message: unknown) => void) | null = null;

  constructor() {
    this.term.onData((reply) => {
      if (this.sessionId) this.input(reply);
    });
  }

  post(message: HostToRenderer): void {
    if (this.closed) return;
    this.messages.push(message);
    setImmediate(() => this.receive(message));
  }
  onMessage(callback: (message: unknown) => void): void { this.messageListener = callback; }
  onClose(): void {}
  close(): void { this.closed = true; }

  send(message: Record<string, unknown>): void { this.messageListener?.(message); }
  input(data: string): void {
    this.inputs.push(data);
    this.send({ type: 'input', sessionId: this.sessionId, data });
  }
  type(line: string): void { this.input(`${line}\r`); }
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    this.send({ type: 'resize', sessionId: this.sessionId, cols, rows });
  }

  /** Acks everything parsed so far (used while acks are held). */
  releaseAcks(): void {
    if (this.parsedUnacked > 0 && this.sessionId) {
      this.send({ type: 'ack', sessionId: this.sessionId, chars: this.parsedUnacked });
      this.parsedUnacked = 0;
    }
  }

  lines(): string[] {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return lines;
  }

  hasLine(text: string): boolean {
    return this.lines().some((line) => line.trim() === text);
  }

  private receive(message: HostToRenderer): void {
    switch (message.type) {
      case 'create-result':
        if (message.ok) this.sessionId = message.session.sessionId;
        break;
      case 'attach-result':
        if (message.ok) {
          this.sessionId = message.session.sessionId;
          // Restore at the snapshot's size; the requested size follows.
          this.term.resize(message.session.cols, message.session.rows);
          this.term.write(message.snapshot);
        }
        break;
      case 'data':
        this.raw += message.data;
        this.term.write(message.data, () => {
          this.parsedUnacked += message.data.length;
          while (!this.holdAcks && this.parsedUnacked >= FLOW_ACK_BATCH) {
            this.send({ type: 'ack', sessionId: message.sessionId, chars: FLOW_ACK_BATCH });
            this.parsedUnacked -= FLOW_ACK_BATCH;
          }
        });
        break;
      case 'exit':
        this.exitCode = message.exitCode;
        break;
      default:
        break;
    }
  }
}

interface FlowStats { pauses: number; resumes: number; paused: boolean }

interface Harness {
  host: PtyHost;
  main: HostToMain[];
  stats: FlowStats[];
  connect(windowId: string): RendererEmulator;
  startShell(renderer: RendererEmulator): Promise<SessionInfo>;
  mainRequest<T extends HostToMain['type']>(message: Record<string, unknown>, type: T): Promise<Extract<HostToMain, { type: T }>>;
}

const hosts: PtyHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function harness(): Harness {
  const nodePty = require('node-pty') as typeof import('node-pty');
  const environment = new FreshEnvironment();
  const main: HostToMain[] = [];
  const stats: FlowStats[] = [];
  let requests = 0;
  const host = new PtyHost({
    postToMain: (message) => main.push(message),
    spawn: (file, args, options) => {
      const pty = nodePty.spawn(file, args, options);
      const entry: FlowStats = { pauses: 0, resumes: 0, paused: false };
      stats.push(entry);
      const pause = pty.pause.bind(pty);
      const resume = pty.resume.bind(pty);
      pty.pause = () => { entry.pauses += 1; entry.paused = true; pause(); };
      pty.resume = () => { entry.resumes += 1; entry.paused = false; resume(); };
      return pty satisfies PtyLike;
    },
    // Pass the profile commandline straight through (shell-launch.ts is tested on its own).
    buildLaunch: (input) => {
      const [file, ...args] = splitCommandLine(input.commandline);
      return { file, args, env: input.env, shellKind: 'cmd', integrated: false };
    },
    readEnvironment: () => environment.get(),
  });
  hosts.push(host);
  host.start();
  host.handleMainMessage({ type: 'init', shellIntegrationDir: '', handoffPipeName: null, windowsBuild: 26200, scrollback: 50_000 });

  return {
    host,
    main,
    stats,
    connect(windowId) {
      const renderer = new RendererEmulator();
      host.handleMainMessage({ type: 'connect-window', windowId }, [renderer]);
      return renderer;
    },
    async startShell(renderer) {
      const requestId = `create-${++requests}`;
      renderer.send({
        type: 'create',
        requestId,
        paneId: `pane-${requests}`,
        cols: 80,
        rows: 24,
        launch: { profileId: 'cmd', commandline: CMD, cwd: process.cwd(), shellIntegration: false },
      });
      const reply = await until(() => renderer.messages.find((message): message is Extract<HostToRenderer, { type: 'create-result' }> =>
        message.type === 'create-result' && message.requestId === requestId), 20_000, 'create-result');
      if (!reply.ok) throw new Error(reply.error);
      await until(() => renderer.sessionId, 5_000, 'session id');
      const marker = `ready-${requests}`;
      renderer.type(`echo ${marker}`);
      await until(() => renderer.hasLine(marker), 20_000, 'shell ready');
      return reply.session;
    },
    async mainRequest(message, type) {
      const requestId = `main-${++requests}`;
      host.handleMainMessage({ ...message, requestId });
      return until(() => main.find((entry): entry is Extract<HostToMain, { type: typeof type }> =>
        entry.type === type && 'requestId' in entry && entry.requestId === requestId), 20_000, type);
    },
  };
}

async function childPids(parentPid: number, image: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Where-Object Name -eq '${image}' | ForEach-Object ProcessId`],
    { windowsHide: true },
  );
  return stdout.split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function isRunning(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync(path.join(system32, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { windowsHide: true });
  return stdout.includes(`"${pid}"`);
}

describe.skipIf(!windows)('pty host with real node-pty (cmd.exe /d /q)', () => {
  it('creates a shell, answers the startup DA1 through the renderer and round-trips echo', async () => {
    const h = harness();
    const renderer = h.connect('w1');
    const session = await h.startShell(renderer);

    expect(session).toMatchObject({ kind: 'shell', paneId: 'pane-1', cols: 80, rows: 24, exited: false, cwd: path.resolve(process.cwd()) });
    expect(session.pid).toBeGreaterThan(0);
    // Bundled ConPTY asks DA1 and blocks until answered; the renderer answered, the mirror did not.
    expect(renderer.raw).toContain(DA1_QUERY);
    expect(renderer.inputs).toContain(DA1_REPLY);

    renderer.type('echo hello');
    await until(() => renderer.hasLine('hello'), 10_000, 'hello');
    renderer.type('echo %LOOKOUT_SESSION_ID%');
    await until(() => renderer.hasLine(session.sessionId), 10_000, 'session id echo');
  }, 60_000);

  it('resizes the pty and the mirror', async () => {
    const h = harness();
    const renderer = h.connect('w1');
    const { sessionId } = await h.startShell(renderer);
    renderer.resize(100, 30);
    renderer.type('mode con');
    await until(() => renderer.lines().some((line) => /Columns:\s+100\b/.test(line)), 10_000, 'mode con output');
    const list = await h.mainRequest({ type: 'list' }, 'list-result');
    expect(list.sessions.find((entry) => entry.sessionId === sessionId)).toMatchObject({ cols: 100, rows: 30 });
  }, 60_000);

  it('attaches from a second window with a snapshot and moves live output there', async () => {
    const h = harness();
    const a = h.connect('wa');
    const { sessionId } = await h.startShell(a);
    a.type('echo first-marker');
    await until(() => a.hasLine('first-marker'), 10_000, 'first marker');

    const b = h.connect('wb');
    b.send({ type: 'attach', requestId: 'attach-1', sessionId, paneId: 'pane-b', cols: 100, rows: 30 });
    const result = await until(() => b.messages.find((message): message is Extract<HostToRenderer, { type: 'attach-result' }> =>
      message.type === 'attach-result'), 10_000, 'attach-result');
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot).toContain('first-marker');
    expect(result.session).toMatchObject({ cols: 80, rows: 24 });
    await until(() => b.hasLine('first-marker'), 5_000, 'snapshot restored');
    b.resize(100, 30);

    const aRawAtAttach = a.raw.length;
    a.type('echo from-a'); // No longer the owner: ignored.
    b.type('echo second-marker');
    await until(() => b.hasLine('second-marker'), 10_000, 'second marker');
    expect(a.raw.slice(aRawAtAttach)).not.toContain('second-marker');
    expect(b.lines().some((line) => line.includes('from-a'))).toBe(false);
  }, 60_000);

  it('kills the whole process tree', async () => {
    const h = harness();
    const renderer = h.connect('w1');
    const session = await h.startShell(renderer);
    renderer.type('ping -t 127.0.0.1');
    let pingPid = 0;
    for (const deadline = Date.now() + 20_000; !pingPid; await new Promise((resolve) => setTimeout(resolve, 200))) {
      if (Date.now() > deadline) throw new Error('ping did not start');
      [pingPid = 0] = await childPids(session.pid, 'PING.EXE');
    }
    expect(await isRunning(pingPid)).toBe(true);

    const killedAt = Date.now();
    renderer.send({ type: 'kill', sessionId: session.sessionId });
    await until(() => renderer.exitCode !== null, 15_000, 'exit');
    // A real pty exit, not the host's fallback after KILL_EXIT_GRACE_MS.
    expect(Date.now() - killedAt).toBeLessThan(4_000);
    expect(await isRunning(pingPid)).toBe(false);
    expect(await isRunning(session.pid)).toBe(false);
    expect(h.host.sessionIds).toEqual([]);
  }, 90_000);

  it('reports a natural exit with its code and drops the session', async () => {
    const h = harness();
    const renderer = h.connect('w1');
    await h.startShell(renderer);
    renderer.type('exit 7');
    await until(() => renderer.exitCode !== null, 10_000, 'exit');
    expect(renderer.exitCode).toBe(7);
    expect(h.host.sessionIds).toEqual([]);
  }, 60_000);

  it('serializes the buffer for persistence', async () => {
    const h = harness();
    const renderer = h.connect('w1');
    const { sessionId } = await h.startShell(renderer);
    renderer.type('echo serialize-marker');
    await until(() => renderer.hasLine('serialize-marker'), 10_000, 'serialize marker');
    const result = await h.mainRequest({ type: 'serialize', scrollbackLines: 1000 }, 'serialize-result');
    const buffer = result.buffers.find((entry) => entry.sessionId === sessionId);
    expect(buffer).toMatchObject({ paneId: 'pane-1', ownerWindowId: 'w1' });
    expect(buffer?.data).toContain('serialize-marker');
  }, 60_000);

  it('pauses and resumes a flood without losing data', async () => {
    const h = harness();
    const renderer = h.connect('w1');
    await h.startShell(renderer);
    const [stats] = h.stats;

    // Hold acks until the host pauses the pty, then ack everything parsed.
    renderer.holdAcks = true;
    const releaser = setInterval(() => {
      if (stats.paused) renderer.releaseAcks();
    }, 10);
    try {
      renderer.type('for /L %i in (1,1,30000) do @echo line%i');
      renderer.type('echo flood-done');
      await until(() => renderer.hasLine('flood-done'), 120_000, 'flood to finish');
    } finally {
      clearInterval(releaser);
    }

    const numbers = renderer.lines()
      .map((line) => /^line(\d+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    expect(numbers.length).toBe(30_000);
    expect(numbers.every((value, index) => value === index + 1)).toBe(true);
    expect(stats.pauses).toBeGreaterThanOrEqual(1);
    expect(stats.resumes).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
