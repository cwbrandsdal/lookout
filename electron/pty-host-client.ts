import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';

import { HOST_PORT_MESSAGE } from '../src/shared/ipc';
import type { HostToMain, MainToHost, SerializedBuffer, SessionInfo } from '../src/shared/host-protocol';
import { paths } from './paths';

type InitMessage = Extract<MainToHost, { type: 'init' }>;
type ListedSession = SessionInfo & { ownerWindowId: string | null };

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Owns the pty host utility process: forks it, plumbs one MessagePort per
 * window straight to the renderer, and restarts it if it crashes (windows are
 * re-connected; their sessions are gone, which the renderers surface as exits).
 */
export class PtyHostClient {
  private child: UtilityProcess | null = null;
  private disposed = false;
  private requestCounter = 0;
  private readonly pending = new Map<string, { resolve: (message: HostToMain) => void; timer: NodeJS.Timeout }>();
  private readonly windows = new Map<string, WebContents>();
  private restartAttempts = 0;

  onHandoff: (session: SessionInfo) => void = () => {};
  onLog: (level: string, message: string) => void = (level, message) => {
    console.log(`[pty-host:${level}] ${message}`);
  };

  private init: InitMessage;

  constructor(init: InitMessage) {
    this.init = init;
    this.start();
  }

  private start(): void {
    const child = utilityProcess.fork(paths.ptyHost, [], {
      serviceName: 'Lookout Pty Host',
      stdio: 'inherit',
    });
    this.child = child;

    child.on('message', (message: HostToMain) => this.handleMessage(message));
    child.on('exit', (code) => {
      if (this.child !== child) {
        return;
      }

      this.child = null;
      for (const [requestId, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ type: 'log', level: 'error', message: `pty host exited before answering ${requestId}` });
      }
      this.pending.clear();

      if (this.disposed) {
        return;
      }

      this.onLog('error', `pty host exited with code ${code}; restarting`);
      const delay = Math.min(5000, 250 * 2 ** this.restartAttempts);
      this.restartAttempts += 1;
      setTimeout(() => {
        if (this.disposed) {
          return;
        }
        this.start();
        for (const [windowId, webContents] of this.windows) {
          if (!webContents.isDestroyed()) {
            this.connectWindow(windowId, webContents);
          }
        }
      }, delay);
    });

    child.postMessage(this.init);
  }

  private handleMessage(message: HostToMain): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'ready':
        this.restartAttempts = 0;
        return;
      case 'log':
        this.onLog(message.level, message.message);
        return;
      case 'handoff-arrived':
        this.onHandoff(message.session);
        return;
      case 'serialize-result':
      case 'list-result':
      case 'kill-all-result': {
        const entry = this.pending.get(message.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(message.requestId);
          entry.resolve(message);
        }
        return;
      }
      default:
        return;
    }
  }

  private post(message: MainToHost, transfer?: Electron.MessagePortMain[]): void {
    this.child?.postMessage(message, transfer);
  }

  private request(build: (requestId: string) => MainToHost): Promise<HostToMain | null> {
    if (!this.child) {
      return Promise.resolve(null);
    }

    const requestId = `main-${++this.requestCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      this.post(build(requestId));
    });
  }

  /** Creates a fresh MessageChannel between the host and a window's renderer. */
  connectWindow(windowId: string, webContents: WebContents): void {
    this.windows.set(windowId, webContents);
    if (!this.child || webContents.isDestroyed()) {
      return;
    }

    const { port1, port2 } = new MessageChannelMain();
    this.post({ type: 'connect-window', windowId }, [port1]);
    webContents.postMessage(HOST_PORT_MESSAGE, null, [port2]);
  }

  disconnectWindow(windowId: string, killSessions: boolean): void {
    this.windows.delete(windowId);
    this.post({ type: 'disconnect-window', windowId, killSessions });
  }

  async serialize(scrollbackLines: number): Promise<SerializedBuffer[]> {
    const result = await this.request((requestId) => ({ type: 'serialize', requestId, scrollbackLines }));
    return result?.type === 'serialize-result' ? result.buffers : [];
  }

  async list(): Promise<ListedSession[]> {
    const result = await this.request((requestId) => ({ type: 'list', requestId }));
    return result?.type === 'list-result' ? result.sessions : [];
  }

  async killAll(): Promise<void> {
    await this.request((requestId) => ({ type: 'kill-all', requestId }));
  }

  setScrollback(scrollback: number): void {
    this.init = { ...this.init, scrollback };
    this.post({ type: 'set-scrollback', scrollback });
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill();
    this.child = null;
  }
}
