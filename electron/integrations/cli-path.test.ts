import { describe, expect, it } from 'vitest';
import { planCliPath, planPathUpdate, planUserPathWrite } from './cli-path';
import type { IntegrationContext } from './cli-path';

const dir = 'C:\\Users\\test\\AppData\\Local\\Lookout\\bin';
const ctx: IntegrationContext = {
  exePath: 'C:\\Program Files\\Lookout\\Lookout.exe', userDataDir: 'C:\\Data', nativeDir: 'C:\\Native', isPackaged: true,
};

describe('user PATH plan (no registry or environment writes)', () => {
  it('appends to an empty or populated user PATH', () => {
    expect(planPathUpdate('', dir, true)).toBe(dir);
    expect(planPathUpdate('C:\\Windows;%USERPROFILE%\\bin', dir, true)).toBe(`C:\\Windows;%USERPROFILE%\\bin;${dir}`);
    expect(planPathUpdate('C:\\Windows;', dir, true)).toBe(`C:\\Windows;${dir}`);
  });

  it('recognizes casing, trailing separators, quotes and forward slashes', () => {
    const existing = `C:\\Other; "${dir.toUpperCase()}\\" ;C:\\Last`;
    expect(planPathUpdate(existing, dir, true)).toBe(existing);
    expect(planPathUpdate(dir.replaceAll('\\', '/'), dir, true)).toBe(dir.replaceAll('\\', '/'));
    expect(planPathUpdate(`C:\\Other;${dir}\\;${dir.toUpperCase()};C:\\Last`, dir, true)).toBe(`C:\\Other;${dir}\\;C:\\Last`);
  });

  it('preserves unexpanded entries while recognizing the local app-data alias', () => {
    const env = { LocalAppData: 'C:\\Users\\test\\AppData\\Local' };
    const current = 'C:\\Other;%LOCALAPPDATA%\\Lookout\\bin;%USERPROFILE%\\bin';
    expect(planPathUpdate(current, dir, true, env)).toBe(current);
    expect(planPathUpdate(current, dir, false, env)).toBe('C:\\Other;%USERPROFILE%\\bin');
  });

  it('removes all exact matches without removing siblings or other entries', () => {
    expect(planPathUpdate(`${dir};C:\\Other;${dir.toUpperCase()}\\;${dir}-extra`, dir, false)).toBe(`C:\\Other;${dir}-extra`);
    expect(planPathUpdate('C:\\Other', dir, false)).toBe('C:\\Other');
    expect(planPathUpdate(dir, dir, false)).toBe('');
    expect(planPathUpdate('', dir, false)).toBe('');
  });

  it('is idempotent in either direction', () => {
    const added = planPathUpdate('C:\\Other', dir, true);
    expect(planPathUpdate(added, dir, true)).toBe(added);
    const removed = planPathUpdate(added, dir, false);
    expect(planPathUpdate(removed, dir, false)).toBe(removed);
  });

  it('preserves a PATH longer than the setx limit', () => {
    const current = Array.from({ length: 200 }, (_, index) => `C:\\Tools\\${index}`).join(';');
    expect(current.length).toBeGreaterThan(1024);
    expect(planPathUpdate(current, dir, true)).toBe(`${current};${dir}`);
  });

  it.each(['String', 'ExpandString'] as const)('preserves %s and broadcasts the environment change', (kind) => {
    const value = 'C:\\Other;%USERPROFILE%\\Tools';
    const script = planUserPathWrite({ value, kind }, `${value};${dir}`);
    const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
    expect(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'))).toEqual({ expected: value, kind, value: `${value};${dir}` });
    expect(script).toContain('DoNotExpandEnvironmentNames');
    expect(script).toContain('User PATH changed concurrently.');
    expect(script).toContain("CreateSubKey('Environment')");
    expect(script).toContain('SendMessageTimeout');
    expect(script).toContain("'Environment', 2, 5000");
    expect(script).not.toMatch(/setx/i);
  });
});

describe('CLI shim plan', () => {
  it('places a small cmd shim and launcher in local app data', () => {
    const plan = planCliPath(ctx, 'C:\\Users\\test\\AppData\\Local');
    expect(plan.binDir).toBe(dir);
    expect(plan.shimPath).toBe(`${dir}\\lookout.cmd`);
    expect(plan.launcherPath).toBe(`${dir}\\lookout-launch.ps1`);
    expect(plan.shim).toBe([
      '@echo off', 'setlocal DisableDelayedExpansion',
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0lookout-launch.ps1" %*',
      'exit /b %errorlevel%', '',
    ].join('\r\n'));
  });

  it('passes the untouched raw argument tail and inherits cwd without waiting for the app', () => {
    const { launcher } = planCliPath(ctx, 'C:\\Users\\test\\AppData\\Local');
    expect(launcher).toContain('[Environment]::CommandLine.Substring($match.Length)');
    expect(launcher).toContain("$startInfo.FileName = 'C:\\Program Files\\Lookout\\Lookout.exe'");
    expect(launcher).toContain("$startInfo.Arguments = '' + $rawArguments");
    expect(launcher).toContain('$startInfo.WorkingDirectory = [Environment]::CurrentDirectory');
    expect(launcher).toContain('$startInfo.UseShellExecute = $false');
    expect(launcher).not.toMatch(/WaitForExit|Start-Process|Invoke-Expression/);
    expect(launcher.charCodeAt(0)).toBe(0xfeff);
  });

  it('quotes dev app paths and escapes PowerShell literals', () => {
    const plan = planCliPath({ ...ctx, exePath: "C:\\O'Brien\\electron.exe", isPackaged: false, appPath: 'D:\\My App' }, 'C:\\Local');
    expect(plan.launcher).toContain("$startInfo.FileName = 'C:\\O''Brien\\electron.exe'");
    expect(plan.launcher).toContain('$startInfo.Arguments = \'"D:\\My App" \' + $rawArguments');
  });

  it('rejects missing or relative local app-data directories', () => {
    expect(() => planCliPath(ctx, '')).toThrow('absolute Windows path');
    expect(() => planCliPath(ctx, 'relative')).toThrow('absolute Windows path');
  });
});
