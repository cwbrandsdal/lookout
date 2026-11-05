import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileDefinition } from '../../src/shared/settings';

const mocks = vi.hoisted(() => ({
  files: new Set<string>(),
  aliases: new Set<string>(),
  folders: [] as string[],
  responses: new Map<string, string>(),
  run: vi.fn(),
  ssh: vi.fn<() => Promise<string[]>>(),
}));

vi.mock('node:fs/promises', () => ({
  stat: async (path: string) => {
    if (mocks.aliases.has(path)) throw new Error('EACCES');
    return { isFile: () => mocks.files.has(path) };
  },
  access: async (path: string) => { if (!mocks.aliases.has(path)) throw new Error('ENOENT'); },
  lstat: async (path: string) => ({ isSymbolicLink: () => mocks.aliases.has(path) }),
  readdir: async () => mocks.folders,
}));
vi.mock('node:child_process', () => ({ execFile: mocks.run }));
vi.mock('./ssh-config', () => ({ loadSshConfigHosts: mocks.ssh }));

import { detectProfiles, mergeDetectedProfiles } from './detect';

const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', USERPROFILE: 'C:\\Users\\test' };
const system32 = join(env.SystemRoot, 'System32');
const pwsh = join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');

beforeEach(() => {
  mocks.files.clear();
  mocks.aliases.clear();
  mocks.folders = [];
  mocks.responses.clear();
  mocks.ssh.mockReset().mockResolvedValue([]);
  mocks.run.mockReset().mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    const output = mocks.responses.get([file, ...args].join('|'));
    callback(output === undefined ? new Error('Not available') : null, output ?? '');
  });
});

describe('detectProfiles', () => {
  it('discovers stable/preview shells, registry WSL and Git, VS developer shells, SSH, CLIs and Azure helpers', async () => {
    const install = 'C:\\VS Preview';
    const git = 'D:\\Applications\\Git';
    const vswhere = join(env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const preview = join(env.ProgramFiles, 'PowerShell', '7-preview', 'pwsh.exe');
    for (const path of [pwsh, preview, join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), join(system32, 'cmd.exe'), vswhere,
      join(git, 'bin', 'bash.exe'), join(install, 'Common7', 'Tools', 'Microsoft.VisualStudio.DevShell.dll'),
      join(install, 'Common7', 'Tools', 'VsDevCmd.bat')]) mocks.files.add(path);
    mocks.folders = ['7', '7-preview'];
    mocks.responses.set([join(system32, 'where.exe'), 'pwsh.exe'].join('|'), pwsh);
    mocks.responses.set([join(system32, 'reg.exe'), 'query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'].join('|'), `InstallPath    REG_SZ    ${git}`);
    mocks.responses.set([join(system32, 'reg.exe'), 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s', '/v', 'DistributionName'].join('|'), 'DistributionName    REG_SZ    Ubuntu\nDistributionName    REG_SZ    docker-desktop\nDistributionName REG_SZ docker-desktop-data\nDistributionName REG_SZ My Distro');
    mocks.responses.set([vswhere, '-all', '-prerelease', '-format', 'json'].join('|'), JSON.stringify([{ instanceId: 'abc123', installationPath: install, installationVersion: '18.0', catalog: { productLineVersion: '18' }, isPrerelease: true }, { instanceId: 'missing', installationPath: 'C:\\missing' }]));
    mocks.responses.set([join(system32, 'where.exe'), 'claude'].join('|'), 'C:\\claude.exe');
    mocks.responses.set([join(system32, 'where.exe'), 'codex'].join('|'), 'C:\\codex.cmd');
    mocks.responses.set([pwsh, '-NoLogo', '-NonInteractive', '-Command', "Get-Command -Name 'Use-Az*' -CommandType Function,Alias -ErrorAction SilentlyContinue | ForEach-Object Name"].join('|'), 'profile banner\nUse-AzFabrikam\nUse-AzContoso\nUse-AzFabrikam');
    mocks.ssh.mockResolvedValue(['devbox']);
    const detected = await detectProfiles({ env });
    expect(detected.every((item) => item.source === 'detected' && !!item.shellKind)).toBe(true);
    expect(detected.map((item) => item.id)).toEqual(['pwsh', 'pwsh-preview', 'windows-powershell', 'cmd', 'git-bash', 'wsl-my-distro', 'wsl-ubuntu', 'vs-powershell-abc123', 'vs-cmd-abc123', 'ssh-devbox', 'claude', 'codex', 'use-azcontoso', 'use-azfabrikam']);
    expect(detected.find((item) => item.id === 'git-bash')?.commandline).toBe(`"${join(git, 'bin', 'bash.exe')}" --login -i`);
    expect(detected.find((item) => item.id === 'wsl-my-distro')).toMatchObject({ commandline: 'wsl.exe -d "My Distro"', startingDirectory: '~' });
    expect(detected.find((item) => item.id === 'vs-powershell-abc123')).toMatchObject({ name: 'Developer PowerShell for VS 18 [Preview]', commandline: `powershell.exe -NoExit -Command "&{Import-Module """${join(install, 'Common7', 'Tools', 'Microsoft.VisualStudio.DevShell.dll')}"""; Enter-VsDevShell abc123 -SkipAutomaticLocation -SetDefaultWindowTitle}"` });
    expect(detected.find((item) => item.id === 'claude')).toMatchObject({ commandline: `"${pwsh}"`, startupCommand: 'claude', shellKind: 'pwsh' });
    expect(detected.find((item) => item.id === 'use-azfabrikam')).toMatchObject({ name: 'Azure · Fabrikam', startupCommand: 'Use-AzFabrikam' });
    expect(mocks.run.mock.calls.every((call) => (call[2] as { windowsHide: boolean }).windowsHide)).toBe(true);
    expect(mocks.run.mock.calls.some((call) => String(call[0]).toLowerCase().endsWith('wsl.exe'))).toBe(false);
  });

  it('returns partial discoveries when processes fail, including a timed-out helper probe', async () => {
    mocks.files.add(pwsh);
    const detected = await detectProfiles({ env, timeoutMs: 25 });
    expect(detected.map((item) => item.id)).toEqual(['pwsh']);
    expect(mocks.run.mock.calls.every((call) => (call[2] as { timeout: number }).timeout === 25)).toBe(true);
  });

  it('recognizes runnable Store AppExecLink aliases when stat returns EACCES', async () => {
    const alias = join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe');
    mocks.aliases.add(alias);
    expect(await detectProfiles({ env })).toEqual([expect.objectContaining({ id: 'pwsh', commandline: alias, shellKind: 'pwsh' })]);
  });

  it('never throws and uses powershell.exe for CLIs if pwsh is unavailable', async () => {
    mocks.responses.set([join(system32, 'where.exe'), 'codex'].join('|'), 'C:\\codex.cmd');
    expect(await detectProfiles({ env })).toEqual([expect.objectContaining({ id: 'codex', commandline: 'powershell.exe', startupCommand: 'codex', shellKind: 'powershell' })]);
    mocks.run.mockImplementation(() => { throw new Error('spawn failed'); });
    mocks.ssh.mockRejectedValue(new Error('unreadable'));
    await expect(detectProfiles({ env })).resolves.toEqual([]);
  });
});

describe('mergeDetectedProfiles', () => {
  it('preserves user/imported profiles and detected edits, hides missing detections, and adds new profiles immutably', () => {
    const existing: ProfileDefinition[] = [
      { id: 'pwsh', name: 'My shell', commandline: 'custom.exe', source: 'detected', font: { size: 20 }, hidden: true },
      { id: 'custom', name: 'Custom', commandline: 'custom.exe', source: 'user' },
      { id: 'wsl-old', name: 'Old', commandline: 'wsl.exe -d old', source: 'detected' },
      { id: 'import', name: 'Imported', commandline: 'cmd.exe', source: 'windows-terminal' },
    ];
    const detected: ProfileDefinition[] = [
      { id: 'pwsh', name: 'PowerShell', commandline: 'pwsh.exe', source: 'detected' },
      { id: 'cmd', name: 'Command Prompt', commandline: 'cmd.exe', source: 'detected' },
      { id: 'custom', name: 'New detection', commandline: 'other.exe', source: 'detected' },
    ];
    const before = structuredClone(existing);
    const merged = mergeDetectedProfiles(existing, detected);
    expect(merged).toEqual([existing[0], existing[1], { ...existing[2], hidden: true }, existing[3], detected[1]]);
    expect(existing).toEqual(before);
    expect(merged[0]).not.toBe(existing[0]);
  });
});
