import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { elevatedLaunchScript, isInstanceMarkerLive, removeInstanceMarker, writeInstanceMarker } from './elevation';

describe('elevatedLaunchScript', () => {
  it('passes one quoted command line to Start-Process', () => {
    expect(elevatedLaunchScript('C:\\Program Files\\Lookout\\Lookout.exe', ['new-tab', '-d', "D:\\Bjørn's Projects"])).toBe(
      `Start-Process -FilePath 'C:\\Program Files\\Lookout\\Lookout.exe' -ArgumentList 'new-tab -d "D:\\Bjørn''s Projects" --elevated' -Verb RunAs`,
    );
  });

  it.runIf(process.platform === 'win32')('arrives as the same separate arguments', async () => {
    // The same Start-Process minus the UAC verb, against node writing out its argv.
    const dir = await mkdtemp(join(tmpdir(), 'lookout-elevation-'));
    try {
      const out = join(dir, 'argv.json');
      const script = join(dir, 'argv.cjs');
      await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`);
      const args = ['open', 'Infra tools', '-d', 'D:\\My Projects\\', 'say "hi"'];
      const command = elevatedLaunchScript(process.execPath, [script, ...args]).replace(/ -Verb RunAs$/, ' -Wait -WindowStyle Hidden');
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30_000 });
      expect(JSON.parse(await readFile(out, 'utf8'))).toEqual([...args, '--elevated']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('instance marker', () => {
  it('names a running process until that process removes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lookout-marker-'));
    try {
      const file = join(dir, 'Lookout-Admin', 'running.pid');
      expect(isInstanceMarkerLive(file)).toBe(false);
      writeInstanceMarker(file);
      expect(await readFile(file, 'utf8')).toBe(String(process.pid));
      expect(isInstanceMarkerLive(file)).toBe(true);

      // Another instance's marker is left alone.
      removeInstanceMarker(file, process.pid + 1);
      expect(existsSync(file)).toBe(true);
      removeInstanceMarker(file);
      expect(existsSync(file)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores a crashed instance and garbage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lookout-marker-'));
    try {
      const file = join(dir, 'running.pid');
      writeInstanceMarker(file, 0x7ffffff0);
      expect(isInstanceMarkerLive(file)).toBe(false);
      await writeFile(file, 'not a pid');
      expect(isInstanceMarkerLive(file)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('counts a process it may not open (an elevated one) as running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lookout-marker-'));
    try {
      // PID 4 is the System process: always there, never openable from a normal process.
      const file = join(dir, 'running.pid');
      writeInstanceMarker(file, 4);
      expect(isInstanceMarkerLive(file)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
