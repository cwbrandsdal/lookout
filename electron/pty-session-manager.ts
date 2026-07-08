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

// Coalesce PTY output before crossing the IPC boundary: heavy TUI redraws emit
// thousands of tiny chunks per second, and one renderer message per chunk janks.
const OUTPUT_FLUSH_INTERVAL_MS = 5;
const OUTPUT_FLUSH_THRESHOLD = 262_144;

// ConPTY's input buffer can drop data on very large single writes (big pastes),
// so anything above one chunk is queued and paced.
const INPUT_CHUNK_SIZE = 4096;

interface SessionRecord {
  paneId: string;
  projectSpaceId: string;
  ptyProcess: IPty;
  pendingOutput: string;
  outputFlushTimer: NodeJS.Timeout | null;
  inputQueue: string[];
  drainingInput: boolean;
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

      const spawnOptions = {
        cols: request.cols ?? 120,
        rows: request.rows ?? 34,
        cwd,
        env,
        name: 'xterm-256color',
        useConpty: true,
      };

      let ptyProcess: IPty;
      try {
        // Prefer the ConPTY bundled with node-pty (from the Windows Terminal
        // project) over the in-box Windows one; fall back if it fails to load.
        ptyProcess = pty.spawn(shellPath, shellArgs, { ...spawnOptions, useConptyDll: true });
      } catch {
        ptyProcess = pty.spawn(shellPath, shellArgs, spawnOptions);
      }

      const record: SessionRecord = {
        paneId: request.paneId,
        projectSpaceId: request.projectSpaceId,
        ptyProcess,
        pendingOutput: '',
        outputFlushTimer: null,
        inputQueue: [],
        drainingInput: false,
      };
      this.sessions.set(sessionId, record);

      ptyProcess.onData((data) => {
        this.queueOutput(sessionId, record, data);
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        this.flushOutput(sessionId, record);
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

    this.teardownSession(session);
    this.sessions.delete(sessionId);
  }

  stopSessionsForPaneIds(paneIds: string[]): void {
    const paneIdsSet = new Set(paneIds);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (paneIdsSet.has(session.paneId)) {
        this.teardownSession(session);
        this.sessions.delete(sessionId);
      }
    }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (!session.inputQueue.length && data.length <= INPUT_CHUNK_SIZE) {
      session.ptyProcess.write(data);
      return;
    }

    for (let offset = 0; offset < data.length; offset += INPUT_CHUNK_SIZE) {
      session.inputQueue.push(data.slice(offset, offset + INPUT_CHUNK_SIZE));
    }

    this.drainInput(sessionId, session);
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
      this.teardownSession(session);
    }

    this.sessions.clear();
  }

  private teardownSession(session: SessionRecord): void {
    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer);
      session.outputFlushTimer = null;
    }

    session.inputQueue.length = 0;
    session.ptyProcess.kill();
  }

  private queueOutput(sessionId: string, record: SessionRecord, data: string): void {
    record.pendingOutput += data;

    if (record.pendingOutput.length >= OUTPUT_FLUSH_THRESHOLD) {
      this.flushOutput(sessionId, record);
      return;
    }

    if (!record.outputFlushTimer) {
      record.outputFlushTimer = setTimeout(() => {
        this.flushOutput(sessionId, record);
      }, OUTPUT_FLUSH_INTERVAL_MS);
    }
  }

  private flushOutput(sessionId: string, record: SessionRecord): void {
    if (record.outputFlushTimer) {
      clearTimeout(record.outputFlushTimer);
      record.outputFlushTimer = null;
    }

    if (!record.pendingOutput) {
      return;
    }

    const data = record.pendingOutput;
    record.pendingOutput = '';
    this.emit({
      type: 'data',
      sessionId,
      paneId: record.paneId,
      projectSpaceId: record.projectSpaceId,
      data,
    });
  }

  private drainInput(sessionId: string, session: SessionRecord): void {
    if (session.drainingInput) {
      return;
    }

    session.drainingInput = true;

    const writeNext = () => {
      if (this.sessions.get(sessionId) !== session) {
        session.drainingInput = false;
        return;
      }

      const chunk = session.inputQueue.shift();
      if (chunk === undefined) {
        session.drainingInput = false;
        return;
      }

      try {
        session.ptyProcess.write(chunk);
      } catch {
        session.inputQueue.length = 0;
        session.drainingInput = false;
        return;
      }

      setTimeout(writeNext, 1);
    };

    writeNext();
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
