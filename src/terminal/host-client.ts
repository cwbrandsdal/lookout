// Renderer side of the pty host protocol (see src/shared/host-protocol.ts).

import { FLOW_ACK_BATCH, type HostToRenderer, type LaunchSpec, type RendererToHost, type SessionInfo } from '../shared/host-protocol';
import { HOST_PORT_MESSAGE } from '../shared/ipc';

export interface SessionListener {
  onData(data: string, done: () => void): void;
  onExit(exitCode: number): void;
}

type Pending = (message: HostToRenderer) => void;

const REQUEST_TIMEOUT_MS = 15_000;

export class HostClient {
  private port: MessagePort | null = null;
  private readonly queue: RendererToHost[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, SessionListener>();
  private readonly unacked = new Map<string, number>();
  private ackTimer: number | null = null;
  private counter = 0;
  private readonly connectedWaiters: Array<() => void> = [];
  /** Fired whenever a (new) port is connected; the first call is the initial connection. */
  onConnected: (isReconnect: boolean) => void = () => {};
  private connectedOnce = false;

  constructor() {
    window.addEventListener('message', (event) => {
      if (event.data === HOST_PORT_MESSAGE && event.ports[0]) {
        this.connect(event.ports[0]);
      }
    });
  }

  private connect(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (event: MessageEvent<HostToRenderer>) => this.handle(event.data);
    port.start();

    const isReconnect = this.connectedOnce;
    this.connectedOnce = true;
    if (isReconnect) {
      // Requests that were in flight on the old port will never be answered.
      for (const [requestId, resolve] of this.pending) {
        resolve({ type: 'create-result', requestId, ok: false, error: 'The terminal host restarted.' });
      }
      this.pending.clear();
    }

    for (const message of this.queue.splice(0)) {
      port.postMessage(message);
    }
    this.connectedWaiters.splice(0).forEach((resolve) => resolve());
    this.onConnected(isReconnect);
  }

  whenConnected(): Promise<void> {
    return this.port ? Promise.resolve() : new Promise((resolve) => this.connectedWaiters.push(resolve));
  }

  private send(message: RendererToHost): void {
    if (this.port) {
      this.port.postMessage(message);
    } else {
      this.queue.push(message);
    }
  }

  private request<T extends HostToRenderer>(build: (requestId: string) => RendererToHost): Promise<T> {
    const requestId = `r${++this.counter}`;
    return new Promise<T>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ type: 'create-result', requestId, ok: false, error: 'The terminal host did not respond.' } as T);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, (message) => {
        window.clearTimeout(timer);
        resolve(message as T);
      });
      this.send(build(requestId));
    });
  }

  private handle(message: HostToRenderer): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'data': {
        const listener = this.listeners.get(message.sessionId);
        if (!listener) {
          // Nobody renders it (pane closing); ack immediately so the pty never stalls.
          this.ack(message.sessionId, message.data.length);
          return;
        }
        const length = message.data.length;
        listener.onData(message.data, () => this.ack(message.sessionId, length));
        return;
      }
      case 'exit':
        this.listeners.get(message.sessionId)?.onExit(message.exitCode);
        return;
      case 'create-result':
      case 'attach-result':
      case 'list-result': {
        const resolve = this.pending.get(message.requestId);
        if (resolve) {
          this.pending.delete(message.requestId);
          resolve(message);
        }
        return;
      }
      default:
        return;
    }
  }

  private ack(sessionId: string, chars: number): void {
    const total = (this.unacked.get(sessionId) ?? 0) + chars;
    if (total >= FLOW_ACK_BATCH) {
      this.unacked.delete(sessionId);
      this.send({ type: 'ack', sessionId, chars: total });
      return;
    }

    this.unacked.set(sessionId, total);
    if (this.ackTimer === null) {
      this.ackTimer = window.setTimeout(() => {
        this.ackTimer = null;
        for (const [id, count] of this.unacked) {
          this.send({ type: 'ack', sessionId: id, chars: count });
        }
        this.unacked.clear();
      }, 30);
    }
  }

  listen(sessionId: string, listener: SessionListener): () => void {
    this.listeners.set(sessionId, listener);
    return () => {
      if (this.listeners.get(sessionId) === listener) {
        this.listeners.delete(sessionId);
      }
    };
  }

  async create(paneId: string, launch: LaunchSpec, cols: number, rows: number): Promise<{ ok: true; session: SessionInfo } | { ok: false; error: string }> {
    const result = await this.request<Extract<HostToRenderer, { type: 'create-result' }>>((requestId) => ({
      type: 'create',
      requestId,
      paneId,
      launch,
      cols,
      rows,
    }));
    return result.ok ? { ok: true, session: result.session } : { ok: false, error: result.error };
  }

  async attach(
    sessionId: string,
    paneId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: true; session: SessionInfo; snapshot: string } | { ok: false; error: string }> {
    const result = await this.request<HostToRenderer>((requestId) => ({ type: 'attach', requestId, sessionId, paneId, cols, rows }));
    if (result.type === 'attach-result') {
      return result.ok ? { ok: true, session: result.session, snapshot: result.snapshot } : { ok: false, error: result.error };
    }
    return { ok: false, error: result.type === 'create-result' && !result.ok ? result.error : 'Attach failed.' };
  }

  async list(): Promise<SessionInfo[]> {
    const result = await this.request<HostToRenderer>((requestId) => ({ type: 'list', requestId }));
    return result.type === 'list-result' ? result.sessions : [];
  }

  input(sessionId: string, data: string): void {
    this.send({ type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  kill(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.send({ type: 'kill', sessionId });
  }
}
