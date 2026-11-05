import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export interface IntegrationContext { exePath: string; userDataDir: string; nativeDir: string; isPackaged: boolean }
export interface IntegrationStatus { id: string; enabled: boolean; available: boolean; detail?: string }
export const TERMINAL_CLSID = '{783ED3D2-4BC6-48B9-B30C-F13AE92A7AB9}';
export const PROXY_CLSID = '{E1C44C58-2D96-4A52-988B-D3017E3BC7C5}';
export const HANDOFF_PIPE_NAME = `\\\\.\\pipe\\lookout-handoff-${createHash('sha256').update(`${hostname()}\\${userInfo().username}`).digest('hex').slice(0, 24)}`;
const STARTUP = 'HKCU\\Console\\%%Startup';
const CONFIG = 'HKCU\\Software\\Lookout\\Handoff';
const CLASSES = 'HKCU\\Software\\Classes\\CLSID\\';
const REG = 'C:\\Windows\\System32\\reg.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ZERO = '{00000000-0000-0000-0000-000000000000}';
const exec = promisify(execFile);
export interface RegistryValue { type: string; data: string; separator?: string }
export interface DelegationSnapshot { DelegationConsole: RegistryValue | null; DelegationTerminal: RegistryValue | null }
interface Backup { version: 1; startup: DelegationSnapshot }
const ID = 'default-terminal';

// Serialize settings actions so a double click cannot replace the original backup.
let pending: Promise<unknown> = Promise.resolve();
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const next = pending.then(action, action);
  pending = next.catch(() => {});
  return next;
}

export function quoteWindowsArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Invalid Windows command argument');
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function buildRestoreCommands(snapshot: DelegationSnapshot): string[][] {
  return (['DelegationConsole', 'DelegationTerminal'] as const).map((name) => {
    const value = snapshot[name];
    return value
      ? ['add', STARTUP, '/v', name, '/t', value.type, '/d', value.data, ...(value.separator ? ['/s', value.separator] : []), '/f', '/reg:64']
      : ['delete', STARTUP, '/v', name, '/f', '/reg:64'];
  });
}

export function buildRegistrationCommands(ctx: IntegrationContext): string[][] {
  const helper = join(ctx.nativeDir, 'LookoutHandoff.exe');
  const launchArguments = ctx.isPackaged ? '' : quoteWindowsArgument(resolve(ctx.nativeDir, '../../..'));
  return [
    ['add', `${CLASSES}${TERMINAL_CLSID}\\LocalServer32`, '/ve', '/t', 'REG_SZ', '/d', `${quoteWindowsArgument(helper)} -Embedding`, '/f', '/reg:64'],
    ['add', `${CLASSES}${PROXY_CLSID}\\InprocServer32`, '/ve', '/t', 'REG_SZ', '/d', join(ctx.nativeDir, 'LookoutHandoffProxy.dll'), '/f', '/reg:64'],
    ['add', `${CLASSES}${PROXY_CLSID}\\InprocServer32`, '/v', 'ThreadingModel', '/t', 'REG_SZ', '/d', 'Both', '/f', '/reg:64'],
    ...Object.entries({ ExePath: ctx.exePath, PipeName: HANDOFF_PIPE_NAME, LaunchArguments: launchArguments }).map(([name, data]) => [
      'add', CONFIG, '/v', name, '/t', 'REG_SZ', '/d', data, '/f', '/reg:64',
    ]),
  ];
}

async function reg(args: string[]): Promise<string> {
  return (await exec(REG, args, { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
}

async function query(key: string, name: string): Promise<RegistryValue | null> {
  if (!key.startsWith('HKCU\\')) throw new Error('Expected a per-user registry key');
  // reg query's human-readable output loses leading spaces and embedded newlines.
  // Read exact values through .NET; writes still use execFile(reg.exe, args).
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key.slice(5).replace(/'/g, "''")}')
if (!$key) { 'null'; exit }
try {
  $name = '${name.replace(/'/g, "''")}'
  if ($key.GetValueNames() -notcontains $name) { 'null'; exit }
  $kind = $key.GetValueKind($name).ToString()
  $data = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $separator = $null
  switch ($kind) {
    'String' { $type = 'REG_SZ' }
    'ExpandString' { $type = 'REG_EXPAND_SZ' }
    'DWord' { $type = 'REG_DWORD'; $data = '0x' + $data.ToString('x') }
    'QWord' { $type = 'REG_QWORD'; $data = '0x' + $data.ToString('x') }
    'Binary' { $type = 'REG_BINARY'; $data = [BitConverter]::ToString($data).Replace('-', '') }
    'None' { $type = 'REG_NONE'; $data = [BitConverter]::ToString($data).Replace('-', '') }
    'MultiString' {
      $type = 'REG_MULTI_SZ'
      foreach ($candidate in 1..31) { if (($data -join '').IndexOf([char]$candidate) -lt 0) { $separator = [string][char]$candidate; break } }
      if (!$separator) { throw 'Cannot preserve the multi-string registry value.' }
      $data = $data -join $separator
    }
    default { throw "Unsupported registry type: $kind" }
  }
  $result = @{ type=$type; data=[string]$data }
  if ($separator) { $result.separator=$separator }
  $result | ConvertTo-Json -Compress
} finally { $key.Dispose() }
`;
  const { stdout } = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as RegistryValue | null;
}

async function snapshot(): Promise<DelegationSnapshot> {
  const [DelegationConsole, DelegationTerminal] = await Promise.all([
    query(STARTUP, 'DelegationConsole'), query(STARTUP, 'DelegationTerminal'),
  ]);
  return { DelegationConsole, DelegationTerminal };
}

async function restore(value: DelegationSnapshot): Promise<void> {
  for (const command of buildRestoreCommands(value)) {
    if (command[0] === 'delete' && !(await query(STARTUP, command[3]))) continue;
    await reg(command);
  }
}

const DISCOVER_CONSOLE = `
$ErrorActionPreference = 'Stop'
$p = Get-AppxPackage -Name Microsoft.WindowsTerminal | Where-Object { !$_.IsResourcePackage } | Select-Object -First 1
if (!$p) { throw 'Windows Terminal stable is not installed for this user.' }
[xml]$m = Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml')
$c = $m.SelectSingleNode("//*[local-name()='AppExtension' and @Name='com.microsoft.windows.console.host']//*[local-name()='Clsid']")
$i = $m.SelectSingleNode("//*[local-name()='Interface' and @Id='6F23DA90-15C5-4203-9DB0-64E73F1B1B00']")
if (!$c -or !$i) { throw 'Windows Terminal must support ITerminalHandoff3. Update it from the Microsoft Store.' }
@{ clsid=$c.InnerText; version=$p.Version.ToString() } | ConvertTo-Json -Compress
`;

async function prerequisites(ctx: IntegrationContext): Promise<{ clsid: string; version: string }> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Default terminal handoff requires Windows x64.');
  await Promise.all(['LookoutHandoff.exe', 'LookoutHandoffProxy.dll', 'conpty.dll'].map((file) => access(join(ctx.nativeDir, file))));
  await access(ctx.exePath);
  const { stdout } = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DISCOVER_CONSOLE, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (!value || typeof value !== 'object' || !('clsid' in value) || typeof value.clsid !== 'string'
    || !/^\{[\da-f-]{36}\}$/i.test(value.clsid) || !('version' in value) || typeof value.version !== 'string') {
    throw new Error('Invalid Windows Terminal package registration.');
  }
  return { clsid: value.clsid, version: value.version };
}

async function readBackup(ctx: IntegrationContext): Promise<Backup | undefined> {
  try {
    const backup = JSON.parse(await readFile(join(ctx.userDataDir, 'default-terminal-backup.json'), 'utf8')) as Backup;
    if (backup.version !== 1 || !backup.startup) throw new Error('Invalid default-terminal backup; refusing to replace it.');
    for (const name of ['DelegationConsole', 'DelegationTerminal'] as const) {
      const value = backup.startup[name];
      if (value !== null && (!value || typeof value.type !== 'string'
        || !/^REG_(SZ|EXPAND_SZ|DWORD|QWORD|BINARY|NONE|MULTI_SZ)$/.test(value.type) || typeof value.data !== 'string'
        || (value.separator !== undefined && (typeof value.separator !== 'string' || value.separator.length !== 1)))) {
        throw new Error('Invalid default-terminal backup value; refusing to replace it.');
      }
    }
    return backup;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function status(ctx: IntegrationContext): Promise<IntegrationStatus> {
  let enabled = false;
  try {
    if (process.platform === 'win32') enabled = (await query(STARTUP, 'DelegationTerminal'))?.data.toUpperCase() === TERMINAL_CLSID;
    const console = await prerequisites(ctx);
    const current = await query(STARTUP, 'DelegationConsole');
    return { id: ID, enabled: enabled && current?.data.toUpperCase() === console.clsid.toUpperCase(), available: true,
      detail: `Uses Windows Terminal ${console.version} OpenConsole. Unpackaged registration is not listed in Windows Settings; elevated consoles are not supported.` };
  } catch (error) {
    return { id: ID, enabled, available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function getDefaultTerminalStatus(ctx: IntegrationContext): Promise<IntegrationStatus> { return serialize(() => status(ctx)); }

export function enableDefaultTerminal(ctx: IntegrationContext): Promise<IntegrationStatus> {
  return serialize(async () => {
    const console = await prerequisites(ctx);
    const previous = await snapshot();
    const backup = await readBackup(ctx);
    if (!backup) {
      if (previous.DelegationTerminal?.data.toUpperCase() === TERMINAL_CLSID) throw new Error('Lookout is already selected but its backup is missing. Disable it first to restore Windows defaults.');
      await mkdir(ctx.userDataDir, { recursive: true });
      const path = join(ctx.userDataDir, 'default-terminal-backup.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, startup: previous } satisfies Backup, null, 2), { flag: 'wx' });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    }
    try {
      for (const command of buildRegistrationCommands(ctx)) await reg(command);
      await reg(['add', STARTUP, '/v', 'DelegationConsole', '/t', 'REG_SZ', '/d', console.clsid, '/f', '/reg:64']);
      await reg(['add', STARTUP, '/v', 'DelegationTerminal', '/t', 'REG_SZ', '/d', TERMINAL_CLSID, '/f', '/reg:64']);
    } catch (error) {
      await restore(previous);
      throw error;
    }
    return status(ctx);
  });
}

export function disableDefaultTerminal(ctx: IntegrationContext): Promise<IntegrationStatus> {
  return serialize(async () => {
    if (process.platform !== 'win32') return { id: ID, available: false, enabled: false, detail: 'Windows only.' };
    const backup = await readBackup(ctx);
    await restore(backup?.startup ?? { DelegationConsole: { type: 'REG_SZ', data: ZERO }, DelegationTerminal: { type: 'REG_SZ', data: ZERO } });
    // Only Lookout's unique class/config keys are removed. Never unregister a Microsoft class or interface.
    for (const key of [`${CLASSES}${TERMINAL_CLSID}`, `${CLASSES}${PROXY_CLSID}`, CONFIG]) {
      try { await reg(['delete', key, '/f', '/reg:64']); }
      catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
    }
    if (backup) await unlink(join(ctx.userDataDir, 'default-terminal-backup.json'));
    return status(ctx);
  });
}
