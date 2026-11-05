import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import { joinCommandLine } from '../../src/shared/commandline';
import { buildShellLaunch } from './shell-launch';

const require = createRequire(import.meta.url);
const integrationDir = fileURLToPath(new URL('../../resources/shell-integration', import.meta.url));
const windows = process.platform === 'win32';
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsApps = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
function executableExists(file: string): boolean {
  try {
    const stat = lstatSync(file);
    return stat.isFile() || stat.isSymbolicLink();
  } catch { return false; }
}
const storePowerShell = windows && existsSync(windowsApps)
  ? readdirSync(windowsApps).filter((name) => name.startsWith('Microsoft.PowerShell_')).map((name) => path.join(windowsApps, name, 'pwsh.exe'))
  : [];
const pwsh = [
  path.join(windowsApps, 'pwsh.exe'),
  ...storePowerShell,
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
].find(executableExists);
const bash = [
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
].find(existsSync);

interface Session {
  pty: IPty;
  nonce: string;
  output: () => string;
  waitFor: (predicate: (output: string) => boolean, from?: number) => Promise<string>;
  close: () => void;
}

function start(file: string, args: string[] = [], startupCommand?: string, shellIntegration = true): Session {
  const launch = buildShellLaunch({
    commandline: joinCommandLine([file, ...args]),
    startupCommand,
    cwd: process.cwd(),
    shellIntegration,
    shellIntegrationDir: integrationDir,
    env,
  });
  // Load only when a Windows test actually runs; unsupported machines skip cleanly.
  const nodePty = require('node-pty') as typeof import('node-pty');
  const pty = nodePty.spawn(launch.file, launch.args, {
    name: 'xterm-256color',
    cols: 160,
    rows: 40,
    cwd: process.cwd(),
    env: launch.env,
    useConpty: true,
    useConptyDll: true,
  });
  let output = '';
  let exited = false;
  const listeners = new Set<() => void>();
  pty.onData((data) => {
    const before = output.length;
    output += data;
    // The bundled ConPTY blocks startup until it receives this DA1 response.
    const tail = output.slice(Math.max(0, before - 2));
    for (const _match of tail.matchAll(/\x1b\[c/g)) {
      pty.write('\x1b[?1;2c');
    }
    for (const notify of listeners) { notify(); }
  });
  pty.onExit(() => {
    exited = true;
    for (const notify of listeners) { notify(); }
  });
  return {
    pty,
    nonce: launch.env.LOOKOUT_NONCE,
    output: () => output,
    waitFor: (predicate, from = 0) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(check);
        // Keep diagnostics short: profiles are real and may contain private output.
        reject(new Error(`Shell integration timed out; received ${output.length - from} characters`));
      }, 20_000);
      const check = () => {
        const chunk = output.slice(from);
        if (predicate(chunk) || exited) {
          clearTimeout(timeout);
          listeners.delete(check);
          if (exited && !predicate(chunk)) { reject(new Error('Shell exited before the expected marker')); }
          else { resolve(chunk); }
        }
      };
      listeners.add(check);
      check();
    }),
    close: () => { if (!exited) { pty.kill(); } },
  };
}

// ConPTY may translate the OSC terminator from BEL to ST.
function records(output: string): string[] {
  return Array.from(output.matchAll(/\x1b\]633;([^\x07\x1b]*)(?:\x07|\x1b\\)/g), (match) => match[1]);
}

function escaped(value: string): string {
  return value.replace(/[\\;\x00-\x1f]/g, (char) => char === '\\' ? '\\\\' : `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function hasPrompt(output: string): boolean {
  return records(output).includes('B');
}

async function command(session: Session, text: string): Promise<string> {
  const from = session.output().length;
  session.pty.write(`${text}\r`);
  return session.waitFor(hasPrompt, from);
}

describe.skipIf(!windows)('PowerShell integration through bundled ConPTY', () => {
  for (const [name, file] of [['pwsh', pwsh], ['Windows PowerShell 5.1', existsSync(powershell) ? powershell : undefined]] as const) {
    it.skipIf(!file)(`${name}: real profiles, cwd, command boundaries, nonce, exit codes and startup`, async () => {
      const session = start(file!, [], 'Write-Output LOOKOUT_STARTUP_OK');
      try {
        const initial = await session.waitFor((output) => output.includes('LOOKOUT_STARTUP_OK') && records(output).filter((item) => item === 'B').length >= 2);
        expect(records(initial)).toContain('A');
        expect(records(initial)).toContain(`P;Cwd=${escaped(process.cwd())}`);
        expect(records(initial)).toContain(`E;Write-Output LOOKOUT_STARTUP_OK;${session.nonce}`);
        expect(records(initial)).toContain('C');
        expect(records(initial)).toContain('D;0');

        const cd = await command(session, 'cd $env:TEMP');
        expect(records(cd)).toContain(`P;Cwd=${escaped(process.env.TEMP ?? os.tmpdir())}`);
        expect(records(cd)).toContain(`E;cd $env:TEMP;${session.nonce}`);

        const failed = await command(session, 'cmd /c exit 3');
        expect(records(failed)).toContain('D;3');
        expect(records(failed)).toContain(`E;cmd /c exit 3;${session.nonce}`);
        expect(records(failed)).toContain('C');

        const escapedCommand = 'Write-Output "semi;slash\\tab`t"';
        expect(records(await command(session, escapedCommand))).toContain(`E;${escaped(escapedCommand)};${session.nonce}`);
        expect(records(await command(session, ''))).toContain('D');

        const again = await command(session, `. '${path.join(integrationDir, 'lookout.ps1').replace(/'/g, "''")}'`);
        expect(records(again).filter((item) => item === 'A')).toHaveLength(1);
        expect(records(await command(session, 'Write-Output LOOKOUT_ONCE')).filter((item) => item.startsWith('E;'))).toHaveLength(1);

        const nonFilesystem = records(await command(session, 'Set-Location Env:'));
        expect(nonFilesystem).not.toContainEqual(expect.stringMatching(/^P;Cwd=/));
      } finally {
        session.close();
      }
    }, 120_000);

    it.skipIf(!file)(`${name}: preserves a native startup command's exit code`, async () => {
      const session = start(file!, [], 'cmd /c exit 7');
      try {
        const output = await session.waitFor((output) => records(output).filter((item) => item === 'B').length >= 2);
        expect(records(output)).toContain('D;7');
      } finally { session.close(); }
    }, 30_000);
  }
});

it.skipIf(!windows)('cmd emits prompt/cwd markers and applies startup commands with native quoting', async () => {
  const session = start(process.env.ComSpec ?? 'cmd.exe', ['/d'], 'echo "LOOKOUT_STARTUP_OK %TEMP%"');
  try {
    const initial = await session.waitFor((output) => hasPrompt(output));
    expect(initial).toContain(`"LOOKOUT_STARTUP_OK ${process.env.TEMP ?? os.tmpdir()}"`);
    expect(records(initial)).toContain('A');
    expect(records(initial)).toContain(`P;Cwd=${process.cwd()}`);
    const result = records(await command(session, `cd /d "${process.env.TEMP ?? os.tmpdir()}"`));
    expect(result).toContain(`P;Cwd=${process.env.TEMP ?? os.tmpdir()}`);
    expect(result).toContain('D');
  } finally { session.close(); }
}, 60_000);

it.skipIf(!windows || !bash)('Git Bash emits cwd, command text, exit codes and startup markers', async () => {
  const session = start(bash!, ['--login', '-i'], 'printf LOOKOUT_STARTUP_OK');
  try {
    const initial = await session.waitFor((output) => output.includes('LOOKOUT_STARTUP_OK') && records(output).filter((item) => item === 'B').length >= 2);
    expect(records(initial)).toContain('A');
    expect(records(initial)).toContain(`E;printf LOOKOUT_STARTUP_OK;${session.nonce}`);
    expect(records(initial)).toContain('D;0');
    const result = records(await command(session, 'cd /tmp'));
    expect(result.some((item) => item.startsWith('P;Cwd='))).toBe(true);
    expect(result.find((item) => item.startsWith('P;Cwd='))).not.toBe(records(initial).find((item) => item.startsWith('P;Cwd=')));
    expect(result).toContain(`E;cd /tmp;${session.nonce}`);
    expect(records(await command(session, 'false'))).toContain('D;1');
    expect(records(await command(session, ''))).toContain('D');
  } finally { session.close(); }
}, 90_000);

it.skipIf(!windows || !bash)('Bash preserves a pre-existing PROMPT_COMMAND array and DEBUG trap', async () => {
  const session = start(bash!, ['-i'], undefined, false);
  try {
    session.pty.write('printf "\\nLOOKOUT_READY\\n"\r');
    await session.waitFor((output) => output.includes('\r\nLOOKOUT_READY\r\n'));
    const script = path.join(integrationDir, 'lookout.bash').replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const installation = [
      'PROMPT_COMMAND=(\'printf "\\nORIGINAL_PC_%s\\n" "$?"\' \'printf "\\nSECOND_PC\\n"\')',
      'trap \'__lookout_test_debug_count=$(( ${__lookout_test_debug_count:-0} + 1 ))\' DEBUG',
      `. '${script.replace(/'/g, "'\\''")}'`,
    ].join('; ');
    await command(session, installation);
    const failed = await command(session, 'false');
    expect(records(failed)).toContain('D;1');
    expect(failed).toContain('ORIGINAL_PC_1');
    expect(failed.match(/SECOND_PC/g)).toHaveLength(1);
    const trapped = await command(session, 'printf "\\nDEBUG_COUNT=%s\\n" "$__lookout_test_debug_count"');
    expect(trapped).toMatch(/DEBUG_COUNT=[1-9][0-9]*/);
  } finally { session.close(); }
}, 90_000);
