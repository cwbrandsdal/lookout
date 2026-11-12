import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_HIGH_WATERMARK, FLOW_LOW_WATERMARK } from '../../src/shared/host-protocol';
import type { HostToMain, HostToRenderer, SessionInfo } from '../../src/shared/host-protocol';
import type { HandoffOffer, PtyLike, ShellLaunchInput } from '../../src/shared/pty';
import { FreshEnvironment, mergeEnvironment, parseRegQuery } from './environment';
import { PtyHost } from './host-core';
import type { PtySpawnOptions, StartHandoff, WindowPort } from './host-core';

const DA1_QUERY = '\x1b[c';
const DA1_REPLY = '\x1b[?1;2c';

class FakePty implements PtyLike {
  private static nextPid = 4000;
  readonly pid = FakePty.nextPid++;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  pauses = 0;
  resumes = 0;
  kills = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => { this.dataListeners.delete(listener); } };
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.kills += 1; }
  pause(): void { this.pauses += 1; }
  resume(): void { this.resumes += 1; }

  emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
  emitExit(exitCode: number): void { for (const listener of this.exitListeners) listener({ exitCode }); }
}

class FakePort implements WindowPort {
  readonly messages: HostToRenderer[] = [];
  closed = false;
  private messageListener: ((message: unknown) => void) | null = null;
  private closeListener: (() => void) | null = null;

  post(message: HostToRenderer): void {
    if (!this.closed) this.messages.push(message);
  }
  onMessage(callback: (message: unknown) => void): void { this.messageListener = callback; }
  onClose(callback: () => void): void { this.closeListener = callback; }
  close(): void { this.closed = true; }

  send(message: unknown): void { this.messageListener?.(message); }
  remoteClose(): void { this.closed = true; this.closeListener?.(); }
  data(sessionId?: string): string {
    return this.messages
      .filter((message): message is Extract<HostToRenderer, { type: 'data' }> => message.type === 'data' && (!sessionId || message.sessionId === sessionId))
      .map((message) => message.data)
      .join('');
  }
  ofType<T extends HostToRenderer['type']>(type: T): Array<Extract<HostToRenderer, { type: T }>> {
    return this.messages.filter((message): message is Extract<HostToRenderer, { type: T }> => message.type === type);
  }
}

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  host: PtyHost;
  main: HostToMain[];
  ptys: FakePty[];
  spawns: Array<{ file: string; args: string[]; options: PtySpawnOptions }>;
  launches: ShellLaunchInput[];
  killedTrees: number[];
  handoff: { onSession?: (offer: HandoffOffer) => void; pipeName?: string };
  connect(windowId: string): FakePort;
  create(port: FakePort, overrides?: Record<string, unknown>): Promise<SessionInfo>;
  mainRequest<T extends HostToMain['type']>(message: Record<string, unknown>, type: T): Promise<Extract<HostToMain, { type: T }>>;
}

const hosts: PtyHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function harness(options: { failBundledConpty?: boolean; startHandoff?: StartHandoff } = {}): Harness {
  const main: HostToMain[] = [];
  const ptys: FakePty[] = [];
  const spawns: Harness['spawns'] = [];
  const launches: ShellLaunchInput[] = [];
  const killedTrees: number[] = [];
  const handoff: Harness['handoff'] = {};
  let requests = 0;
  const host = new PtyHost({
    postToMain: (message) => main.push(message),
    spawn: (file, args, spawnOptions) => {
      spawns.push({ file, args, options: spawnOptions });
      if (options.failBundledConpty && spawnOptions.useConptyDll) throw new Error('conpty.dll missing');
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
    buildLaunch: (input) => {
      launches.push(input);
      return { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d'], env: input.env, shellKind: 'cmd', integrated: false };
    },
    readEnvironment: async () => ({ Path: 'C:\\Windows', USERPROFILE: os.homedir(), LOOKOUT_PANE_ID: 'stale-parent-pane' }),
    killTree: async (pid) => { killedTrees.push(pid); },
    startHandoff: options.startHandoff ?? ((handoffOptions) => {
      handoff.onSession = handoffOptions.onSession;
      handoff.pipeName = handoffOptions.pipeName;
      return { close() {} };
    }),
  });
  hosts.push(host);
  host.start();
  host.handleMainMessage({ type: 'init', shellIntegrationDir: 'C:\\lookout\\shell-integration', handoffPipeName: null, windowsBuild: 26200, scrollback: 1000 });

  const result: Harness = {
    host, main, ptys, spawns, launches, killedTrees, handoff,
    connect(windowId) {
      const port = new FakePort();
      host.handleMainMessage({ type: 'connect-window', windowId }, [port]);
      return port;
    },
    async create(port, overrides = {}) {
      const requestId = `create-${++requests}`;
      port.send({
        type: 'create',
        requestId,
        paneId: 'pane-1',
        cols: 80,
        rows: 24,
        launch: { profileId: 'cmd', commandline: 'cmd.exe /d', cwd: process.cwd(), shellIntegration: true },
        ...overrides,
      });
      const reply = await until(() => port.ofType('create-result').find((message) => message.requestId === requestId));
      if (!reply.ok) throw new Error(reply.error);
      return reply.session;
    },
    async mainRequest(message, type) {
      const requestId = `main-${++requests}`;
      host.handleMainMessage({ ...message, requestId });
      return until(() => main.find((entry): entry is Extract<HostToMain, { type: typeof type }> =>
        entry.type === type && 'requestId' in entry && entry.requestId === requestId));
    },
  };
  return result;
}

describe('PtyHost create', () => {
  it('spawns with the bundled ConPTY, a validated cwd and Lookout variables', async () => {
    const h = harness();
    const port = h.connect('w1');
    const session = await h.create(port, { paneId: 'pane-a' });

    expect(h.main[0]).toEqual({ type: 'ready' } satisfies HostToMain);
    expect(h.spawns).toHaveLength(1);
    const [{ options }] = h.spawns;
    expect(options).toMatchObject({ name: 'xterm-256color', cols: 80, rows: 24, cwd: path.resolve(process.cwd()), useConpty: true, useConptyDll: true });
    expect(options.env.LOOKOUT_PANE_ID).toBe('pane-a');
    expect(options.env.LOOKOUT_SESSION_ID).toBe(session.sessionId);
    expect(options.env.LOOKOUT_WINDOW_ID).toBe('w1');
    expect(h.launches[0]).toMatchObject({ commandline: 'cmd.exe /d', shellIntegration: true, shellIntegrationDir: 'C:\\lookout\\shell-integration' });
    expect(session).toMatchObject({ paneId: 'pane-a', kind: 'shell', shellKind: 'cmd', cols: 80, rows: 24, exited: false });
  });

  it('falls back to USERPROFILE for a missing cwd and to the inbox ConPTY when the bundled one fails', async () => {
    const h = harness({ failBundledConpty: true });
    const port = h.connect('w1');
    const missing = path.join(os.tmpdir(), `lookout-missing-${process.pid}-${Date.now()}`);
    const session = await h.create(port, { launch: { profileId: 'x', commandline: 'cmd.exe', cwd: missing, shellIntegration: false } });
    expect(session.cwd).toBe(path.resolve(os.homedir()));
    expect(h.spawns.map((spawn) => spawn.options.useConptyDll)).toEqual([true, undefined]);
  });

  it('reports invalid launches as readable errors', async () => {
    const h = harness();
    const port = h.connect('w1');
    port.send({ type: 'create', requestId: 'bad', paneId: 'p', cols: 80, rows: 24, launch: { commandline: '' } });
    const reply = await until(() => port.ofType('create-result')[0]);
    expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/command line/i) });
  });
});

describe('PtyHost flow control', () => {
  it('pauses above the high watermark and resumes below the low watermark', async () => {
    const h = harness();
    const port = h.connect('w1');
    const { sessionId } = await h.create(port);
    const [pty] = h.ptys;

    pty.emitData('x'.repeat(FLOW_HIGH_WATERMARK));
    await until(() => port.data(sessionId).length === FLOW_HIGH_WATERMARK);
    expect(pty.pauses).toBe(0); // At, not above, the watermark.

    pty.emitData('y'.repeat(20_000));
    await until(() => port.data(sessionId).length === FLOW_HIGH_WATERMARK + 20_000);
    expect(pty.pauses).toBe(1);

    port.send({ type: 'ack', sessionId, chars: FLOW_HIGH_WATERMARK });
    expect(pty.resumes).toBe(0); // 20 000 outstanding is still above the low watermark.
    port.send({ type: 'ack', sessionId, chars: 20_000 - FLOW_LOW_WATERMARK + 1 });
    expect(pty.resumes).toBe(1);
    expect(h.host.getSession(sessionId)?.flowState).toMatchObject({ unacked: FLOW_LOW_WATERMARK - 1, paused: false });
  });

  it('batches output and resets the counters when the owner changes', async () => {
    const h = harness();
    const first = h.connect('w1');
    const { sessionId } = await h.create(first);
    const [pty] = h.ptys;
    for (let index = 0; index < 50; index += 1) pty.emitData('chunk ');
    await until(() => first.ofType('data').length);
    await sleep(20);
    expect(first.ofType('data')).toHaveLength(1);

    pty.emitData('z'.repeat(FLOW_HIGH_WATERMARK + 1));
    await until(() => pty.pauses === 1);

    const second = h.connect('w2');
    second.send({ type: 'attach', requestId: 'a1', sessionId, paneId: 'pane-1', cols: 80, rows: 24 });
    expect(pty.resumes).toBe(1);
    expect(h.host.getSession(sessionId)?.flowState.unacked).toBe(0);
    await until(() => second.ofType('attach-result')[0]);
  });
});

describe('PtyHost ownership', () => {
  it('transfers a session to the attaching window with an exact snapshot', async () => {
    const h = harness();
    const a = h.connect('wa');
    const { sessionId } = await h.create(a);
    const [pty] = h.ptys;
    pty.emitData('hello from A\r\n');
    await until(() => a.data(sessionId).includes('hello from A'));

    const b = h.connect('wb');
    b.send({ type: 'attach', requestId: 'att', sessionId, paneId: 'pane-moved', cols: 100, rows: 30 });
    // Arrives after the snapshot point: must not be in the snapshot, must follow the result.
    pty.emitData('after attach');
    const result = await until(() => b.ofType('attach-result')[0]);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot).toContain('hello from A');
    expect(result.snapshot).not.toContain('after attach');
    expect(result.session).toMatchObject({ cols: 80, rows: 24, paneId: 'pane-moved' }); // Snapshot size.
    expect(b.messages.map((message) => message.type)).toEqual(['attach-result', 'data']);
    expect(b.data(sessionId)).toBe('after attach');
    expect(pty.resizes).toEqual([[100, 30]]); // Applied after the snapshot.

    const before = a.messages.length;
    pty.emitData('only for B');
    await until(() => b.data(sessionId).includes('only for B'));
    expect(a.messages.length).toBe(before);

    // The previous owner can no longer drive the session.
    a.send({ type: 'input', sessionId, data: 'from A' });
    a.send({ type: 'kill', sessionId });
    b.send({ type: 'input', sessionId, data: 'from B' });
    expect(pty.writes).toEqual(['from B']);
    expect(pty.kills).toBe(0);

    const list = await h.mainRequest({ type: 'list' }, 'list-result');
    expect(list.sessions[0]).toMatchObject({ sessionId, ownerWindowId: 'wb', cols: 100, rows: 30 });
  });

  it('replaces the port on connect-window and waits for attach', async () => {
    const h = harness();
    const first = h.connect('w1');
    const { sessionId } = await h.create(first);
    const [pty] = h.ptys;
    pty.emitData('before reload\r\n');
    await until(() => first.data(sessionId));

    const second = h.connect('w1');
    expect(first.closed).toBe(true);
    pty.emitData('during reload\r\n');
    first.send({ type: 'input', sessionId, data: 'stale' });
    second.send({ type: 'input', sessionId, data: 'not attached yet' });
    await sleep(20);
    expect(second.messages).toHaveLength(0);
    expect(pty.writes).toEqual([]);

    second.send({ type: 'attach', requestId: 'r', sessionId, paneId: 'pane-1', cols: 80, rows: 24 });
    const result = await until(() => second.ofType('attach-result')[0]);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot).toContain('before reload');
    expect(result.snapshot).toContain('during reload');
    pty.emitData('live');
    await until(() => second.data(sessionId) === 'live');
  });

  it('kills owned sessions and their process trees on disconnect-window', async () => {
    const h = harness();
    const port = h.connect('w1');
    const { sessionId, pid } = await h.create(port);
    h.host.handleMainMessage({ type: 'disconnect-window', windowId: 'w1', killSessions: true });
    await until(() => h.ptys[0].kills === 1);
    expect(h.killedTrees).toEqual([pid]);
    expect(h.host.sessionIds).not.toContain(sessionId);
  });
});

describe('PtyHost headless mirror replies', () => {
  it('answers terminal queries only while no owner port is attached', async () => {
    const h = harness();
    const port = h.connect('w1');
    const { sessionId } = await h.create(port);
    const [pty] = h.ptys;

    pty.emitData(DA1_QUERY);
    await h.mainRequest({ type: 'serialize', scrollbackLines: 100 }, 'serialize-result'); // Mirror has parsed it.
    expect(pty.writes).toEqual([]); // The attached renderer answers.

    h.host.handleMainMessage({ type: 'disconnect-window', windowId: 'w1', killSessions: false });
    pty.emitData(DA1_QUERY);
    await until(() => pty.writes.length);
    expect(pty.writes).toEqual([DA1_REPLY]);
    expect(h.host.getSession(sessionId)?.exited).toBe(false);
  });

  it('turns handoff offers into ownerless sessions the mirror answers for', async () => {
    const h = harness();
    h.host.handleMainMessage({ type: 'init', shellIntegrationDir: '', handoffPipeName: '\\\\.\\pipe\\lookout-test', windowsBuild: 26200, scrollback: 1000 });
    expect(h.handoff.pipeName).toBe('\\\\.\\pipe\\lookout-test');
    const pty = new FakePty();
    h.handoff.onSession?.({ pty, title: 'C:\\Windows\\System32\\cmd.exe', cols: 120, rows: 30 });
    const arrived = await until(() => h.main.find((message): message is Extract<HostToMain, { type: 'handoff-arrived' }> => message.type === 'handoff-arrived'));
    expect(arrived.session).toMatchObject({ kind: 'handoff', paneId: null, shellKind: 'cmd', cols: 120, rows: 30, pid: pty.pid });

    pty.emitData(DA1_QUERY);
    await until(() => pty.writes.includes(DA1_REPLY));

    const port = h.connect('w1');
    port.send({ type: 'attach', requestId: 'h', sessionId: arrived.session.sessionId, paneId: 'pane-h', cols: 120, rows: 30 });
    await until(() => port.ofType('attach-result')[0]);
    pty.emitData(DA1_QUERY);
    await until(() => port.data().includes(DA1_QUERY));
    await h.mainRequest({ type: 'serialize', scrollbackLines: 10 }, 'serialize-result');
    expect(pty.writes).toEqual([DA1_REPLY]);
  });

  it('logs and survives a handoff server that fails to start', () => {
    const h = harness({ startHandoff: () => { throw new Error('pipe busy'); } });
    h.host.handleMainMessage({ type: 'init', shellIntegrationDir: '', handoffPipeName: '\\\\.\\pipe\\x', windowsBuild: 1, scrollback: 10 });
    expect(h.main).toContainEqual({ type: 'log', level: 'error', message: expect.stringContaining('pipe busy') });
  });
});

describe('PtyHost exit', () => {
  it('drops a session whose exit reached its attached owner', async () => {
    const h = harness();
    const port = h.connect('w1');
    const { sessionId } = await h.create(port);
    h.ptys[0].emitData('bye');
    h.ptys[0].emitExit(0);
    expect(port.messages.slice(-2)).toEqual([{ type: 'data', sessionId, data: 'bye' }, { type: 'exit', sessionId, exitCode: 0 }]);
    expect(h.host.sessionIds).toEqual([]);
  });

  it('keeps an exit that happened while detached until the window lists it', async () => {
    const h = harness();
    const first = h.connect('w1');
    const { sessionId } = await h.create(first);
    const second = h.connect('w1'); // Renderer reload.
    h.ptys[0].emitExit(3);
    expect(second.ofType('exit')).toEqual([]);

    const mainList = await h.mainRequest({ type: 'list' }, 'list-result');
    expect(mainList.sessions).toEqual([expect.objectContaining({ sessionId, exited: true, exitCode: 3, ownerWindowId: 'w1' })]);

    second.send({ type: 'list', requestId: 'l1' });
    expect(second.ofType('list-result')[0].sessions).toEqual([expect.objectContaining({ sessionId, exited: true, exitCode: 3 })]);
    second.send({ type: 'list', requestId: 'l2' });
    expect(second.ofType('list-result')[1].sessions).toEqual([]);
  });

  it('reports a detached exit to the window that attaches', async () => {
    const h = harness();
    const first = h.connect('w1');
    const { sessionId } = await h.create(first);
    h.ptys[0].emitData('last words\r\n');
    first.remoteClose(); // Renderer crashed.
    h.ptys[0].emitExit(9);

    const second = h.connect('w1');
    second.send({ type: 'attach', requestId: 'r', sessionId, paneId: 'pane-1', cols: 80, rows: 24 });
    const result = await until(() => second.ofType('attach-result')[0]);
    if (!result.ok) throw new Error(result.error);
    expect(result.session).toMatchObject({ exited: true, exitCode: 9 });
    expect(result.snapshot).toContain('last words');
    expect(second.ofType('exit')).toEqual([{ type: 'exit', sessionId, exitCode: 9 }]);
    expect(h.host.sessionIds).toEqual([]);
  });

  it('kills the process tree before the pty', async () => {
    const h = harness();
    const port = h.connect('w1');
    const { sessionId, pid } = await h.create(port);
    port.send({ type: 'kill', sessionId });
    await until(() => h.ptys[0].kills === 1);
    expect(h.killedTrees).toEqual([pid]);
  });
});

describe('PtyHost robustness', () => {
  it('ignores malformed messages from main and renderers', async () => {
    const h = harness();
    for (const message of [null, undefined, 'init', 42, [], { type: 7 }, { type: 'nope' }, { type: 'serialize' },
      { type: 'connect-window', windowId: 5 }, { type: 'disconnect-window' }, { type: 'set-scrollback', scrollback: -1 },
      { type: 'list' }, { type: 'kill-all' }, { type: 'init', scrollback: 'many' }]) {
      expect(() => h.host.handleMainMessage(message)).not.toThrow();
    }
    const orphanPort = new FakePort();
    h.host.handleMainMessage({ type: 'connect-window' }, [orphanPort]);
    expect(orphanPort.closed).toBe(true);

    const port = h.connect('w1');
    const { sessionId } = await h.create(port);
    for (const message of [null, 'x', { type: 1 }, { type: 'input' }, { type: 'input', sessionId, data: 5 },
      { type: 'resize', sessionId, cols: -1, rows: 10 }, { type: 'resize', sessionId, cols: 1.5, rows: 10 },
      { type: 'resize', sessionId, cols: 80, rows: 24 }, { type: 'ack', sessionId, chars: Number.NaN },
      { type: 'ack', sessionId, chars: -5 }, { type: 'kill', sessionId: {} }, { type: 'attach', sessionId },
      { type: 'attach', requestId: 'x', sessionId: 'missing' }, { type: 'create', paneId: 'p' },
      { type: 'create', requestId: 'c', paneId: 'p', launch: null }, { type: 'list' }]) {
      expect(() => port.send(message)).not.toThrow();
    }
    expect(h.ptys[0].resizes).toEqual([]); // Invalid sizes and the no-op were ignored.
    expect(port.ofType('attach-result')).toEqual([{ type: 'attach-result', requestId: 'x', ok: false, error: expect.any(String) }]);
    await until(() => port.ofType('create-result').find((message) => message.requestId === 'c'));

    // Still fully functional.
    port.send({ type: 'input', sessionId, data: 'ok' });
    expect(h.ptys[0].writes).toEqual(['ok']);
    const second = await h.create(port, { paneId: 'pane-2' });
    expect(second.sessionId).not.toBe(sessionId);
  });

  it('isolates a session whose pty throws', async () => {
    const h = harness();
    const port = h.connect('w1');
    const broken = await h.create(port);
    const healthy = await h.create(port, { paneId: 'pane-2' });
    const [brokenPty, healthyPty] = h.ptys;
    brokenPty.write = () => { throw new Error('pipe closed'); };
    brokenPty.resize = () => { throw new Error('pipe closed'); };
    port.send({ type: 'input', sessionId: broken.sessionId, data: 'x' });
    port.send({ type: 'resize', sessionId: broken.sessionId, cols: 90, rows: 20 });
    port.send({ type: 'input', sessionId: healthy.sessionId, data: 'y' });
    healthyPty.emitData('still alive');
    await until(() => port.data(healthy.sessionId) === 'still alive');
    expect(healthyPty.writes).toEqual(['y']);
    expect(h.main.some((message) => message.type === 'log' && message.message.includes('pipe closed'))).toBe(true);
  });

  it('serializes persistence buffers without the alt buffer and kills all sessions', async () => {
    const h = harness();
    const port = h.connect('w1');
    const { sessionId } = await h.create(port);
    h.ptys[0].emitData('main screen\r\n\x1b[?1049halt screen');
    const serialized = await h.mainRequest({ type: 'serialize', scrollbackLines: 50 }, 'serialize-result');
    expect(serialized.buffers).toEqual([{ sessionId, paneId: 'pane-1', ownerWindowId: 'w1', data: expect.stringContaining('main screen') }]);
    expect(serialized.buffers[0].data).not.toContain('alt screen');

    await h.mainRequest({ type: 'kill-all' }, 'kill-all-result');
    expect(h.ptys[0].kills).toBe(1);
    expect(h.host.sessionIds).toEqual([]);
  });
});

describe('fresh environment', () => {
  const systemOutput = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
    '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%',
    '    PATHEXT    REG_SZ    .COM;.EXE;.BAT;.CMD',
    '    Empty    REG_SZ    ',
    '    Flags    REG_DWORD    0x1',
    '',
  ].join('\r\n');
  const userOutput = [
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Users\\Bjørn\\tools',
    '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
    '    OneDrive    REG_SZ    C:\\Users\\Bjørn\\OneDrive',
    '    (Default)    REG_SZ    ignored',
  ].join('\r\n');

  it('parses reg.exe output', () => {
    expect(parseRegQuery(systemOutput)).toEqual([
      { name: 'ComSpec', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\system32\\cmd.exe' },
      { name: 'Path', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\system32;%SystemRoot%' },
      { name: 'PATHEXT', type: 'REG_SZ', value: '.COM;.EXE;.BAT;.CMD' },
      { name: 'Empty', type: 'REG_SZ', value: '' },
    ]);
  });

  it('expands values, joins PATH and keeps the process casing', () => {
    const env = mergeEnvironment(
      { SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Bjørn', PATH: 'C:\\stale', temp: 'C:\\old', KEEP: '1' },
      parseRegQuery(systemOutput),
      parseRegQuery(userOutput),
    );
    expect(env).toEqual({
      SYSTEMROOT: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\Bjørn',
      PATH: 'C:\\Windows\\system32;C:\\Windows;C:\\Users\\Bjørn\\bin;C:\\Users\\Bjørn\\tools',
      temp: 'C:\\Users\\Bjørn\\AppData\\Local\\Temp',
      KEEP: '1',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      Empty: '',
      OneDrive: 'C:\\Users\\Bjørn\\OneDrive',
    });
  });

  it('keeps the logon user instead of the system hive USERNAME=SYSTEM', () => {
    const env = mergeEnvironment(
      { USERNAME: 'alex', USERPROFILE: 'C:\\Users\\alex', APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' },
      parseRegQuery(['    USERNAME    REG_SZ    SYSTEM', '    windir    REG_EXPAND_SZ    C:\\Windows'].join('\r\n')),
      parseRegQuery(['    APPDATA    REG_SZ    D:\\elsewhere', '    LogDir    REG_EXPAND_SZ    %USERPROFILE%\\logs'].join('\r\n')),
    );
    expect(env).toEqual({
      USERNAME: 'alex',
      USERPROFILE: 'C:\\Users\\alex',
      APPDATA: 'C:\\Users\\alex\\AppData\\Roaming',
      windir: 'C:\\Windows',
      LogDir: 'C:\\Users\\alex\\logs',
    });
  });

  it.runIf(process.platform === 'win32')('reads the real registry without changing who the user is', async () => {
    const env = await new FreshEnvironment({ readTimeoutMs: 10_000 }).get();
    const value = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
    expect(value('username')).toBe(process.env.USERNAME);
    expect(value('userprofile')).toBe(process.env.USERPROFILE);
    expect(value('comspec')).toBeTruthy();
  });

  /** A registry fake whose HKLM reads return `system<n>`, optionally held open or failing. */
  function fakeRegistry() {
    const registry = {
      reads: 0,
      hold: false,
      fail: false,
      release: () => {},
      query: async (key: string): Promise<string> => {
        if (!key.startsWith('HKLM')) {
          return '';
        }
        registry.reads += 1;
        const read = registry.reads;
        if (registry.hold) {
          await new Promise<void>((resolve) => { registry.release = resolve; });
        }
        if (registry.fail) {
          throw new Error('reg.exe failed');
        }
        return `    Path    REG_SZ    system${read}`;
      },
    };
    return registry;
  }

  it('reads the registry again for a spawn once the last read is stale', async () => {
    let now = 0;
    const registry = fakeRegistry();
    const environment = new FreshEnvironment({ ttlMs: 2_000, now: () => now, baseEnvironment: () => ({}), query: registry.query });

    expect(await environment.get()).toEqual({ Path: 'system1' });
    now = 1_000;
    expect(await environment.get()).toEqual({ Path: 'system1' }); // Same burst: no new read.
    now = 60_000;
    // E.g. a tab opened after an install changed PATH: it must see the change, not the cache.
    expect(await environment.get()).toEqual({ Path: 'system2' });
    expect(registry.reads).toBe(2);
  });

  it('shares one read between concurrent spawns', async () => {
    const registry = fakeRegistry();
    const environment = new FreshEnvironment({ baseEnvironment: () => ({}), query: registry.query });
    const envs = await Promise.all([environment.get(), environment.get(), environment.get()]);
    expect(envs).toEqual([{ Path: 'system1' }, { Path: 'system1' }, { Path: 'system1' }]);
    expect(registry.reads).toBe(1);
  });

  it('falls back to the process environment when the first read is slow', async () => {
    const registry = fakeRegistry();
    registry.hold = true;
    const environment = new FreshEnvironment({ readTimeoutMs: 20, baseEnvironment: () => ({ Path: 'base' }), query: registry.query });

    expect(await environment.get()).toEqual({ Path: 'base' });
    registry.hold = false;
    registry.release();
    await sleep(5);
    expect(await environment.get()).toEqual({ Path: 'system1' });
  });

  it('uses the last good environment when a read is slow, without waiting on it twice', async () => {
    let now = 0;
    const warnings: string[] = [];
    const registry = fakeRegistry();
    const environment = new FreshEnvironment({
      readTimeoutMs: 20,
      now: () => now,
      baseEnvironment: () => ({ Path: 'base' }),
      query: registry.query,
      log: (level, message) => { if (level === 'warn') warnings.push(message); },
    });
    expect(await environment.get()).toEqual({ Path: 'system1' });

    now = 60_000;
    registry.hold = true;
    expect(await environment.get()).toEqual({ Path: 'system1' }); // Timed out.
    expect(await environment.get()).toEqual({ Path: 'system1' }); // Same slow read: no second wait.
    expect(warnings).toHaveLength(1);
    expect(registry.reads).toBe(2);

    registry.hold = false;
    registry.release();
    await sleep(5);
    expect(await environment.get()).toEqual({ Path: 'system2' });
  });

  it('uses the last good environment when a read fails', async () => {
    let now = 0;
    const registry = fakeRegistry();
    const environment = new FreshEnvironment({ now: () => now, baseEnvironment: () => ({ Path: 'base' }), query: registry.query });
    expect(await environment.get()).toEqual({ Path: 'system1' });

    now = 60_000;
    registry.fail = true;
    expect(await environment.get()).toEqual({ Path: 'system1' });
    registry.fail = false;
    expect(await environment.get()).toEqual({ Path: 'system3' }); // Retried on the next spawn.
  });
});
