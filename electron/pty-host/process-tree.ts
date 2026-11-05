import { execFile } from 'node:child_process';
import path from 'node:path';

const TASKKILL_TIMEOUT_MS = 5_000;

function systemExecutable(name: string): string {
  return path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name);
}

/**
 * Force-kills `pid` and every descendant (`taskkill /T /F`), so dev servers and
 * other children started from a shell die with its pane. Never rejects: a
 * process that is already gone is not an error here.
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
      resolve();
      return;
    }
    try {
      execFile(
        systemExecutable('taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
        () => resolve(),
      );
    } catch {
      resolve();
    }
  });
}
