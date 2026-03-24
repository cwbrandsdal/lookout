import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BrowserWindow } from 'electron';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import type { TerminalEvent, TerminalLaunchRequest, TerminalLaunchResponse } from '../src/types/app';

const execFileAsync = promisify(execFile);
const TERMINAL_EVENT_CHANNEL = 'lookout:terminal-event';

interface SessionRecord {
  paneId: string;
  projectSpaceId: string;
  ptyProcess: IPty;
}

export class PtySessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  async startSession(request: TerminalLaunchRequest): Promise<TerminalLaunchResponse> {
    try {
      const cwd = await resolveWorkingDirectory(request.rootPath, request.workingDirectory);
      const shellPath = await resolveShellExecutable(request.executable);
      const sessionId = crypto.randomUUID();
      const shellArgs = request.args.length ? request.args : ['-NoLogo'];
      const env = {
        ...process.env,
        ...request.envVars,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      };

      const ptyProcess = pty.spawn(shellPath, shellArgs, {
        cols: request.cols ?? 120,
        rows: request.rows ?? 34,
        cwd,
        env,
        name: 'xterm-256color',
        useConpty: true,
      });

      this.sessions.set(sessionId, {
        paneId: request.paneId,
        projectSpaceId: request.projectSpaceId,
        ptyProcess,
      });

      ptyProcess.onData((data) => {
        this.emit({
          type: 'data',
          sessionId,
          paneId: request.paneId,
          projectSpaceId: request.projectSpaceId,
          data,
        });
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        this.sessions.delete(sessionId);
        this.emit({
          type: 'exit',
          sessionId,
          paneId: request.paneId,
          projectSpaceId: request.projectSpaceId,
          exitCode,
          signal,
        });
      });

      if (request.startupCommand?.trim()) {
        setTimeout(() => {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.ptyProcess.write(`${request.startupCommand?.trim()}\r`);
          }
        }, 160);
      }

      return {
        ok: true,
        sessionId,
        cwd,
        shellPath,
      };
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    session.ptyProcess.kill();
    this.sessions.delete(sessionId);
  }

  stopSessionsForPaneIds(paneIds: string[]): void {
    const paneIdsSet = new Set(paneIds);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (paneIdsSet.has(session.paneId)) {
        session.ptyProcess.kill();
        this.sessions.delete(sessionId);
      }
    }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    session?.ptyProcess.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);

    if (!session || cols <= 0 || rows <= 0) {
      return;
    }

    session.ptyProcess.resize(cols, rows);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.ptyProcess.kill();
    }

    this.sessions.clear();
  }

  private emit(event: TerminalEvent): void {
    this.getWindow()?.webContents.send(TERMINAL_EVENT_CHANNEL, event);
  }
}

async function resolveWorkingDirectory(rootPath: string, paneOverride?: string): Promise<string> {
  const candidate = paneOverride?.trim()
    ? path.isAbsolute(paneOverride)
      ? paneOverride
      : path.resolve(rootPath, paneOverride)
    : rootPath;

  await access(candidate);
  return candidate;
}

async function resolveShellExecutable(explicitExecutable?: string): Promise<string> {
  const candidates = explicitExecutable?.trim() ? [explicitExecutable.trim()] : ['pwsh', 'powershell.exe'];

  for (const candidate of candidates) {
    const resolved = await resolveCommand(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('PowerShell executable was not found. Install pwsh or use Windows PowerShell.');
}

async function resolveCommand(candidate: string): Promise<string | null> {
  if (path.isAbsolute(candidate) || candidate.includes('\\') || candidate.includes('/')) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('where.exe', [candidate]);
    const firstLine = stdout.split(/\r?\n/).find(Boolean)?.trim();
    return firstLine ?? candidate;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
