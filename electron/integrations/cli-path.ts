import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { joinCommandLine } from '../../src/shared/commandline';
import { integrationLaunchArgs, integrationUnavailableReason } from './explorer-menu';
import type { IntegrationContext, IntegrationStatus } from './explorer-menu';

export type { IntegrationContext, IntegrationStatus } from './explorer-menu';

interface UserPath { value: string; kind: 'String' | 'ExpandString' }
export interface CliPathPlan {
  binDir: string;
  shimPath: string;
  shim: string;
  launcherPath: string;
  launcher: string;
}

const execFileAsync = promisify(execFile);
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function normalizedEntry(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const entries = Object.entries(env);
  const expanded = value.trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (match, name: string) => {
    return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? match;
  });
  return path.win32.normalize(expanded).replace(/[\\/]+$/, '').toLowerCase();
}

/** Preserve unrelated entries verbatim; compare Windows paths case-insensitively. */
export function planPathUpdate(
  current: string,
  dir: string,
  enable: boolean,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const target = normalizedEntry(dir, env);
  const parts = current ? current.split(';') : [];
  let found = false;
  const retained = parts.filter((entry) => {
    if (!entry.trim() || normalizedEntry(entry, env) !== target) return true;
    if (enable && !found) {
      found = true;
      return true;
    }
    return false;
  });
  const value = retained.join(';');
  if (!enable || found) return value;
  return `${value}${value && !value.endsWith(';') ? ';' : ''}${dir}`;
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function planCliPath(ctx: IntegrationContext, localAppData: string): CliPathPlan {
  if (!localAppData || !path.win32.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be an absolute Windows path.');
  const binDir = path.win32.join(localAppData, 'Lookout', 'bin');
  const launchArgs = integrationLaunchArgs(ctx);
  const shim = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0lookout-launch.ps1" %*',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
  // Windows PowerShell 5.1 needs the BOM to decode non-ASCII installation paths.
  const launcher = '\uFEFF' + [
    '# Read the raw native argument tail: PowerShell 5.1 reserializes $args lossily.',
    '# The fixed prefix is exactly the invocation in lookout.cmd; no user text is evaluated.',
    "$ErrorActionPreference = 'Stop'",
    "$prefix = '^(?:\"[^\"]*\"|\\S+)\\s+-NoLogo\\s+-NoProfile\\s+-NonInteractive\\s+-ExecutionPolicy\\s+Bypass\\s+-File\\s+(?:\"[^\"]*\"|\\S+)(?:\\s+|$)'",
    "$match = [regex]::Match([Environment]::CommandLine, $prefix, 'IgnoreCase')",
    "if (-not $match.Success) { throw 'Run this launcher through lookout.cmd.' }",
    '$rawArguments = [Environment]::CommandLine.Substring($match.Length)',
    '$startInfo = New-Object System.Diagnostics.ProcessStartInfo',
    `$startInfo.FileName = ${psLiteral(launchArgs[0])}`,
    `$startInfo.Arguments = ${psLiteral(launchArgs.length > 1 ? `${joinCommandLine(launchArgs.slice(1))} ` : '')} + $rawArguments`,
    '$startInfo.WorkingDirectory = [Environment]::CurrentDirectory',
    '$startInfo.UseShellExecute = $false',
    "# Callers running inside another Electron app may leak ELECTRON_RUN_AS_NODE, which would start Lookout as plain Node.",
    "[void]$startInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')",
    '[System.Diagnostics.Process]::Start($startInfo) | Out-Null',
    '',
  ].join('\r\n');
  return {
    binDir,
    shimPath: path.win32.join(binDir, 'lookout.cmd'),
    shim,
    launcherPath: path.win32.join(binDir, 'lookout-launch.ps1'),
    launcher,
  };
}

const READ_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
try {
  $value = ''
  $kind = 'ExpandString'
  if ($null -ne $key -and $key.GetValueNames() -contains 'Path') {
    $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $key.GetValueKind('Path').ToString()
  }
  @{ value = $value; kind = $kind } | ConvertTo-Json -Compress
} finally { if ($null -ne $key) { $key.Dispose() } }
`;

/** Pure script planner: keep unexpanded data and its registry type, detect lost updates. */
export function planUserPathWrite(current: UserPath, value: string): string {
  if (current.kind !== 'String' && current.kind !== 'ExpandString') throw new Error('User Path must be REG_SZ or REG_EXPAND_SZ.');
  const payload = Buffer.from(JSON.stringify({ expected: current.value, kind: current.kind, value }), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $actual = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = 'ExpandString'
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path').ToString() }
  if ($actual -cne $data.expected -or $kind -cne $data.kind) { throw 'User PATH changed concurrently. Retry the operation.' }
  $key.SetValue('Path', [string]$data.value, [Microsoft.Win32.RegistryValueKind]::$($data.kind))
} finally { $key.Dispose() }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LookoutEnvironmentBroadcast {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
    string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][LookoutEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`;
}

async function powershell(script: string): Promise<string> {
  const utf8Script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n' + script;
  const { stdout } = await execFileAsync(POWERSHELL_EXE, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(utf8Script, 'utf16le').toString('base64'),
  ], { windowsHide: true, encoding: 'utf8' });
  return stdout.replace(/^\uFEFF/, '').trim();
}

async function readUserPath(): Promise<UserPath> {
  const value: unknown = JSON.parse(await powershell(READ_USER_PATH_SCRIPT));
  if (!value || typeof value !== 'object' || !('value' in value) || typeof value.value !== 'string'
    || !('kind' in value) || (value.kind !== 'String' && value.kind !== 'ExpandString')) {
    throw new Error('User Path must be REG_SZ or REG_EXPAND_SZ.');
  }
  return { value: value.value, kind: value.kind };
}

function status(ctx: IntegrationContext, enabled: boolean, detail?: string): IntegrationStatus {
  const unavailable = integrationUnavailableReason(ctx) ?? (!process.env.LOCALAPPDATA ? 'LOCALAPPDATA is not set.' : undefined);
  return { id: 'cli-path', enabled, available: !unavailable, ...(unavailable || detail ? { detail: unavailable ?? detail } : {}) };
}

async function installedFileMatches(file: string, expected: string): Promise<boolean> {
  try {
    return await readFile(file, 'utf8') === expected;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function getCliPathStatus(ctx: IntegrationContext): Promise<IntegrationStatus> {
  if (!status(ctx, false).available) return status(ctx, false);
  try {
    const plan = planCliPath(ctx, process.env.LOCALAPPDATA!);
    const current = await readUserPath();
    const inPath = current.value.split(';').some((entry) => entry.trim()
      && normalizedEntry(entry, process.env) === normalizedEntry(plan.binDir, process.env));
    const filesMatch = await installedFileMatches(plan.shimPath, plan.shim)
      && await installedFileMatches(plan.launcherPath, plan.launcher);
    return status(ctx, Boolean(inPath && filesMatch), inPath !== filesMatch ? 'CLI installation is incomplete or outdated; enable it to repair.' : undefined);
  } catch (error) {
    return status(ctx, false, `Could not read the CLI integration: ${String(error)}`);
  }
}

export async function enableCliPath(ctx: IntegrationContext): Promise<IntegrationStatus> {
  if (!status(ctx, false).available) return status(ctx, false);
  try {
    const plan = planCliPath(ctx, process.env.LOCALAPPDATA!);
    const current = await readUserPath();
    await mkdir(plan.binDir, { recursive: true });
    // Install the helper first so an existing shim never points at a missing helper.
    await writeFile(plan.launcherPath, plan.launcher, 'utf8');
    await writeFile(plan.shimPath, plan.shim, 'utf8');
    const updated = planPathUpdate(current.value, plan.binDir, true, process.env);
    if (updated !== current.value) await powershell(planUserPathWrite(current, updated));
    return getCliPathStatus(ctx);
  } catch (error) {
    return status(ctx, false, `Could not enable the CLI integration: ${String(error)}`);
  }
}

export async function disableCliPath(ctx: IntegrationContext): Promise<IntegrationStatus> {
  if (!status(ctx, false).available) return status(ctx, false);
  try {
    const plan = planCliPath(ctx, process.env.LOCALAPPDATA!);
    const current = await readUserPath();
    const updated = planPathUpdate(current.value, plan.binDir, false, process.env);
    if (updated !== current.value) await powershell(planUserPathWrite(current, updated));
    await rm(plan.shimPath, { force: true });
    await rm(plan.launcherPath, { force: true });
    return getCliPathStatus(ctx);
  } catch (error) {
    const current = await getCliPathStatus(ctx);
    return { ...current, detail: `Could not disable the CLI integration: ${String(error)}` };
  }
}
