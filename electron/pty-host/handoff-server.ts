import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { HandoffOffer, HandoffServer, PtyLike } from '../../src/shared/pty';

// A uint32 LE length (including type), uint8 type, then payload. See native README.
export const HANDOFF_FRAME = { hello: 1, data: 2, resize: 3, close: 4, exit: 5, ready: 6 } as const;
const MAX_FRAME = 1024 * 1024;
const MAX_BACKLOG = 8 * 1024 * 1024;

export function encodeHandoffFrame(type: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (payload.byteLength >= MAX_FRAME) throw new Error('Handoff frame is too large');
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength + 1, 0);
  frame[4] = type;
  frame.set(payload, 5);
  return frame;
}

export class HandoffFrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (type: number, payload: Buffer) => void): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length < 1 || length > MAX_FRAME) throw new Error('Invalid handoff frame length');
      if (this.pending.length < 4 + length) break;
      const frame = this.pending.subarray(4, 4 + length);
      this.pending = this.pending.subarray(4 + length);
      onFrame(frame[0], frame.subarray(1));
    }
  }
}

export interface HandoffHello {
  version: 1;
  pid: number;
  cols: number;
  rows: number;
  title?: string;
  commandLine?: string;
  cwd?: string;
  elevated?: boolean;
}

export function parseHandoffHello(payload: Buffer): HandoffHello {
  const value: unknown = JSON.parse(payload.toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid handoff metadata');
  const hello = value as Record<string, unknown>;
  if (hello.version !== 1 || !validInteger(hello.pid, 1, 0xffffffff)
    || !validInteger(hello.cols, 1, 32767) || !validInteger(hello.rows, 1, 32767)) {
    throw new Error('Invalid handoff metadata');
  }
  for (const field of ['title', 'commandLine', 'cwd'] as const) {
    if (hello[field] !== undefined && typeof hello[field] !== 'string') throw new Error(`Invalid handoff ${field}`);
  }
  if (hello.elevated !== undefined && typeof hello.elevated !== 'boolean') throw new Error('Invalid handoff elevation');
  return hello as unknown as HandoffHello;
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** @internal Exported for pure transport tests. */
export class HandoffPty implements PtyLike {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();
  private readonly decoder = new StringDecoder('utf8');
  private backlog = '';
  private exitEvent: { exitCode: number } | undefined;

  readonly pid: number;
  private readonly socket: Socket;

  constructor(pid: number, socket: Socket) {
    this.pid = pid;
    this.socket = socket;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    if (this.backlog) {
      const backlog = this.backlog;
      this.backlog = '';
      queueMicrotask(() => { if (this.dataListeners.has(listener)) listener(backlog); });
    }
    return { dispose: () => { this.dataListeners.delete(listener); } };
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    const event = this.exitEvent;
    if (event) queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(event); });
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }

  write(data: string): void {
    const bytes = Buffer.from(data, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += MAX_FRAME - 1) {
      this.send(HANDOFF_FRAME.data, bytes.subarray(offset, offset + MAX_FRAME - 1));
    }
  }

  resize(cols: number, rows: number): void {
    if (!validInteger(cols, 1, 32767) || !validInteger(rows, 1, 32767)) return;
    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt32LE(cols, 0);
    payload.writeUInt32LE(rows, 4);
    this.send(HANDOFF_FRAME.resize, payload);
  }

  kill(): void { this.send(HANDOFF_FRAME.close); }
  pause(): void { this.socket.pause(); }
  resume(): void { this.socket.resume(); }

  private send(type: number, payload?: Buffer): void {
    if (this.exitEvent || this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_BACKLOG) { this.socket.destroy(new Error('Handoff input backlog exceeded')); return; }
    this.socket.write(encodeHandoffFrame(type, payload));
  }

  acceptData(payload: Buffer): void {
    if (this.exitEvent) throw new Error('Handoff data after exit');
    this.emitData(this.decoder.write(payload));
  }

  private emitData(data: string): void {
    if (!data) return;
    if (this.dataListeners.size) {
      for (const listener of this.dataListeners) listener(data);
    } else {
      this.backlog += data;
      if (this.backlog.length > MAX_BACKLOG) throw new Error('Handoff output backlog exceeded');
    }
  }

  finish(exitCode: number): void {
    if (this.exitEvent) return;
    this.emitData(this.decoder.end());
    this.exitEvent = { exitCode };
    for (const listener of this.exitListeners) listener(this.exitEvent);
  }
}

export function startHandoffServer(options: {
  pipeName: string;
  onSession: (offer: HandoffOffer) => void;
  log: (message: string) => void;
}): HandoffServer {
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    const frames = new HandoffFrameDecoder();
    let pty: HandoffPty | undefined;
    socket.setTimeout(15_000, () => socket.destroy(new Error('Handoff handshake timed out')));
    socket.on('error', (error) => options.log(`Handoff connection: ${error.message}`));
    socket.on('close', () => { sockets.delete(socket); pty?.finish(1); });
    socket.on('data', (chunk) => {
      try {
        frames.push(chunk, (type, payload) => {
          if (!pty) {
            if (type !== HANDOFF_FRAME.hello) throw new Error('Expected handoff metadata');
            const { version: _version, pid, ...metadata } = parseHandoffHello(payload);
            pty = new HandoffPty(pid, socket);
            options.onSession({ pty, ...metadata });
            socket.setTimeout(0);
            socket.write(encodeHandoffFrame(HANDOFF_FRAME.ready));
          } else if (type === HANDOFF_FRAME.data) {
            pty.acceptData(payload);
          } else if (type === HANDOFF_FRAME.exit && payload.length === 4) {
            pty.finish(payload.readUInt32LE(0));
            socket.end();
          } else {
            throw new Error('Unexpected handoff frame');
          }
        });
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  server.on('error', (error) => options.log(`Handoff server: ${error.message}`));
  server.on('listening', () => { if (closed) server.close(); else options.log(`Handoff listening on ${options.pipeName}`); });
  server.listen(options.pipeName);
  return {
    close(): void {
      closed = true;
      server.close();
      for (const socket of sockets) { socket.end(encodeHandoffFrame(HANDOFF_FRAME.close)); socket.destroySoon(); }
    },
  };
}
