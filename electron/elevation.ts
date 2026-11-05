import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { joinCommandLine } from '../src/shared/commandline';

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

let cachedElevated: boolean | null = null;

/**
 * True when this process runs with a high (administrator) or system integrity
 * level. Uses `whoami /groups` once; it is fast (~30 ms) and needs no native code.
 */
export function isProcessElevated(): boolean {
  if (cachedElevated !== null) {
    return cachedElevated;
  }

  if (process.platform !== 'win32') {
    cachedElevated = false;
    return cachedElevated;
  }

  try {
    const output = execFileSync(path.join(SYSTEM32, 'whoami.exe'), ['/groups'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    cachedElevated = /S-1-16-12288|S-1-16-16384/.test(output);
  } catch {
    cachedElevated = false;
  }

  return cachedElevated;
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * The PowerShell command that starts `exe` elevated. It passes one pre-quoted command
 * line: Windows PowerShell joins an -ArgumentList array with bare spaces, which would
 * split a folder like "C:\My Projects" into two arguments.
 */
export function elevatedLaunchScript(exe: string, args: string[]): string {
  return `Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(joinCommandLine([...args, '--elevated']))} -Verb RunAs`;
}

/**
 * The administrator instance keeps its pid in this file (in its data folder) while it
 * runs. The normal instance then holds updates back: the installer can't close an
 * elevated Lookout.
 */
export const INSTANCE_MARKER_FILE = 'running.pid';

export function writeInstanceMarker(file: string, pid = process.pid): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, String(pid));
  } catch {
    // Best effort: without the marker an update just isn't held back.
  }
}

/** Removes the marker if it is still this process's. */
export function removeInstanceMarker(file: string, pid = process.pid): void {
  try {
    if (readFileSync(file, 'utf8').trim() === String(pid)) {
      unlinkSync(file);
    }
  } catch {
    // Already gone.
  }
}

/**
 * True when the marker names a running process. A normal process can't open an
 * elevated one (EPERM), which still means it is alive; a crash leaves a dead pid.
 */
export function isInstanceMarkerLive(file: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

/** Starts an elevated copy of Lookout through UAC (one prompt per launch, like Windows Terminal). */
export function launchElevated(exe: string, args: string[]): Promise<boolean> {
  const script = elevatedLaunchScript(exe, args);

  return new Promise((resolve) => {
    execFile(
      path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
      (error) => resolve(!error),
    );
  });
}
