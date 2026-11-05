import path from 'node:path';
import { lstatSync, statSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinCommandLine } from '../../src/shared/commandline';
import type { ShellLaunchInput } from '../../src/shared/pty';
import { buildShellLaunch } from './shell-launch';

vi.mock('node:fs', () => ({ statSync: vi.fn(), lstatSync: vi.fn() }));

const input: ShellLaunchInput = {
  commandline: 'pwsh.exe',
  cwd: path.resolve('launch cwd'),
  shellIntegration: true,
  shellIntegrationDir: path.resolve("integration's files"),
  env: {},
};

function launch(overrides: Partial<ShellLaunchInput> = {}) {
  return buildShellLaunch({ ...input, ...overrides });
}

beforeEach(() => {
  vi.mocked(statSync).mockReset();
  vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT'); });
  vi.mocked(lstatSync).mockReset();
  vi.mocked(lstatSync).mockImplementation(() => { throw new Error('ENOENT'); });
});

describe('buildShellLaunch', () => {
  it('preserves user flags and injects PowerShell using unquoted UTF-16LE source', () => {
    const result = launch({ commandline: 'pwsh.exe -NoLogo -ExecutionPolicy RemoteSigned', startupCommand: 'claude' });
    expect(result.args.slice(0, 3)).toEqual(['-NoLogo', '-ExecutionPolicy', 'RemoteSigned']);
    expect(result.args.slice(3, 5)).toEqual(['-NoExit', '-EncodedCommand']);
    const source = Buffer.from(result.args[5], 'base64').toString('utf16le');
    expect(source).toBe(`try { . '${path.join(input.shellIntegrationDir, 'lookout.ps1').replace(/'/g, "''")}' } catch {}`);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBe('claude');
    expect(result.integrated).toBe(true);
    expect(result.shellKind).toBe('pwsh');
  });

  it.each(['-Command', '-c', '-co', '-comm', '-CommandWithArgs', '-cwa', '-File', '-f', '-fi', '-EncodedCommand', '-ec', '-enc', '-ENCODEDC', '/command'])('does not inject over %s', (arg) => {
    const result = launch({ commandline: `powershell.exe ${arg} "Write-Output hi"`, startupCommand: 'claude' });
    expect(result.integrated).toBe(false);
    expect(result.args).toEqual([arg, 'Write-Output hi']);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBeUndefined();
    expect(result.env.LOOKOUT_SHELL_INTEGRATION).toBeUndefined();
  });

  it('keeps PowerShell user arguments as-is, including an absent NoLogo', () => {
    expect(launch().args[0]).toBe('-NoExit');
    expect(launch({ commandline: 'powershell.exe -NoProfile' }).args[0]).toBe('-NoProfile');
  });

  it('launches a startup command even with PowerShell integration disabled', () => {
    const result = launch({ shellIntegration: false, startupCommand: 'Write-Output "hello"' });
    expect(result.integrated).toBe(false);
    expect(result.args.slice(0, 2)).toEqual(['-NoExit', '-EncodedCommand']);
    expect(Buffer.from(result.args[2], 'base64').toString('utf16le')).toBe('Write-Output "hello"');
  });

  it('normalizes terminal environment names without mutating the caller', () => {
    const env = { Path: 'example', term: 'dumb', Term_Program: 'old', lookout_nonce: 'old', LOOKOUT_STARTUP_COMMAND: 'stale' };
    const result = launch({ env });
    expect(result.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Lookout', LOOKOUT_SHELL_INTEGRATION: '1' });
    expect(result.env.term).toBeUndefined();
    expect(result.env.LOOKOUT_NONCE).toMatch(/^[0-9a-f]{32}$/);
    expect(launch().env.LOOKOUT_NONCE).not.toBe(result.env.LOOKOUT_NONCE);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBeUndefined();
    expect(env.term).toBe('dumb');
  });

  it('resolves PATH/PATHEXT and expands profile environment variables', () => {
    const directory = path.resolve('test-bin');
    const executable = path.join(directory, 'pwsh.EXE');
    vi.mocked(statSync).mockImplementation((candidate) => {
      if (candidate === executable) {
        return { isFile: () => true } as ReturnType<typeof statSync>;
      }
      throw new Error('ENOENT');
    });
    const result = launch({ commandline: '%SHELL_EXE% -NoLogo', env: { SHELL_EXE: 'pwsh', Path: directory, PathExt: '.COM;.EXE' } });
    expect(result.file).toBe(executable);
    expect(result.args[0]).toBe('-NoLogo');
  });

  it('keeps paths and arguments raw for node-pty quoting', () => {
    const file = path.resolve('Program Files', 'PowerShell', 'pwsh.exe');
    const result = launch({ commandline: joinCommandLine([file, '-NoLogo']) });
    expect(result.file).toBe(file);
    expect(result.args[0]).toBe('-NoLogo');
    expect(result.args.every((arg) => !arg.startsWith('"'))).toBe(true);
  });

  it('resolves Store AppExecLink aliases even when stat cannot follow them', () => {
    const directory = path.resolve('WindowsApps');
    vi.mocked(lstatSync).mockImplementation((candidate) => {
      if (candidate === path.join(directory, 'pwsh.EXE')) {
        return { isSymbolicLink: () => true } as ReturnType<typeof lstatSync>;
      }
      throw new Error('ENOENT');
    });
    expect(launch({ commandline: 'pwsh', env: { PATH: directory } }).file).toBe(path.join(directory, 'pwsh.EXE'));
  });

  it('injects cmd prompt markers using ST and preserves the user prompt', () => {
    const result = launch({ commandline: 'cmd.exe /d', env: { Prompt: '$T $P$G' } });
    expect(result.env.PROMPT).toBe('$e]633;D$e\\$e]633;A$e\\$e]633;P;Cwd=$P$e\\$T $P$G$e]633;B$e\\');
    expect(result.args).toEqual(['/d']);
    expect(result.integrated).toBe(true);
  });

  it('uses cmd /k with raw startup source kept out of node-pty quoting', () => {
    const startupCommand = '"C:\\Program Files\\tool.exe" "hello world" & echo done';
    const result = launch({ commandline: 'cmd.exe', startupCommand });
    expect(result.args).toEqual(['/k', 'call', '%LOOKOUT_STARTUP_COMMAND%']);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBe(startupCommand);
  });

  it.each(['/c', '/Cecho', '/k', '/Kecho'])('does not replace existing cmd %s', (arg) => {
    const result = launch({ commandline: `cmd.exe ${arg} hi`, startupCommand: 'claude' });
    expect(result.args).toEqual([arg, 'hi']);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBeUndefined();
  });

  it.each(['--login -i', '-l -i', '-il', '-li'])('injects Git Bash and translates login args: %s', (args) => {
    const result = launch({ commandline: `"C:\\Program Files\\Git\\bin\\bash.exe" ${args}`, shellIntegrationDir: 'C:\\Users\\someone\\integration files', startupCommand: 'claude' });
    expect(result.args).toEqual(['--init-file', '/c/Users/someone/integration files/lookout.bash', '-i']);
    expect(result.env.LOOKOUT_SHELL_LOGIN).toBe('1');
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBe('claude');
    expect(result.integrated).toBe(true);
  });

  it.each(['-c "echo hi"', '-ic "echo hi"', 'script.sh'])('leaves Bash execution launches alone: %s', (args) => {
    const result = launch({ commandline: `"C:\\Program Files\\Git\\bin\\bash.exe" ${args}`, startupCommand: 'claude' });
    expect(result.integrated).toBe(false);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBeUndefined();
  });

  it.each(['wsl.exe -d Ubuntu', 'ssh.exe host', 'tool.exe --arg', 'C:\\Windows\\System32\\bash.exe', 'zsh.exe', 'sh.exe'])('does not inject or append startup source for %s', (commandline) => {
    const result = launch({ commandline, startupCommand: 'claude' });
    expect(result.integrated).toBe(false);
    expect(result.env.LOOKOUT_STARTUP_COMMAND).toBeUndefined();
    expect(result.args.join(' ')).not.toContain('claude');
    expect(result.env.TERM_PROGRAM).toBe('Lookout');
  });

  it('can disable integration without altering shell arguments', () => {
    const result = launch({ commandline: 'cmd.exe /d', shellIntegration: false });
    expect(result.args).toEqual(['/d']);
    expect(result.integrated).toBe(false);
    expect(result.env.PROMPT).toBeUndefined();
  });
});
