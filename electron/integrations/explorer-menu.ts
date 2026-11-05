import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface IntegrationContext {
  exePath: string;
  userDataDir: string;
  nativeDir: string;
  isPackaged: boolean;
  appPath?: string;
}

export interface IntegrationStatus {
  id: string;
  enabled: boolean;
  available: boolean;
  detail?: string;
}

export interface ExplorerRegistryValue {
  key: string;
  name: string | null;
  value: string;
}

const execFileAsync = promisify(execFile);
const REG_EXE = 'C:\\Windows\\System32\\reg.exe';
export const EXPLORER_MENU_KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\Lookout',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Lookout',
  'HKCU\\Software\\Classes\\Drive\\shell\\Lookout',
] as const;

export function integrationUnavailableReason(
  ctx: IntegrationContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return 'This integration is available only on Windows.';
  if (!ctx.isPackaged && env.LOOKOUT_DEV_INTEGRATIONS !== '1') return 'Install a packaged build to enable this integration.';
  if (!ctx.isPackaged && !ctx.appPath) return 'Development integrations require an explicit appPath.';
  if (!ctx.exePath) return 'The Lookout executable path is missing.';
  return undefined;
}

export function integrationLaunchArgs(ctx: IntegrationContext): string[] {
  if (!ctx.isPackaged && !ctx.appPath) throw new Error('Development integrations require an explicit appPath.');
  return [ctx.exePath, ...(ctx.isPackaged ? [] : [ctx.appPath!])];
}

/** Pure registry plan. All values are REG_SZ and owned by Lookout. */
export function planExplorerMenu(ctx: IntegrationContext): ExplorerRegistryValue[] {
  // Windows 11 displays these verbs under "Show more options" (the classic menu).
  // A top-level modern menu entry requires package identity and is out of scope.
  return EXPLORER_MENU_KEYS.flatMap((key) => {
    // %1 is the selected folder/drive; %V is the folder hosting a background menu.
    // Shell substitutes these tokens after registration; do not expand environment variables.
    const target = key.includes('\\Background\\') ? '%V' : '%1';
    const command = `${integrationLaunchArgs(ctx).map((arg) => `"${arg}"`).join(' ')} -d "${target}"`;
    return [
      { key, name: null, value: 'Open in Lookout' },
      { key, name: 'Icon', value: ctx.exePath },
      { key: `${key}\\command`, name: null, value: command },
    ];
  });
}

export function planExplorerRegistryCommands(ctx: IntegrationContext, enable: boolean): string[][] {
  if (!enable) return EXPLORER_MENU_KEYS.map((key) => ['delete', key, '/f']);
  return planExplorerMenu(ctx).map(({ key, name, value }) => [
    'add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', value, '/f',
  ]);
}

async function queryValue(value: ExplorerRegistryValue): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(REG_EXE, [
      'query', value.key, ...(value.name === null ? ['/ve'] : ['/v', value.name]),
    ], { windowsHide: true, encoding: 'utf8' });
    return stdout.match(/\s+REG_SZ[\t ]+(.*)/)?.[1].trimEnd();
  } catch (error) {
    if (isMissingRegistryValue(error)) return undefined;
    throw error;
  }
}

function isMissingRegistryValue(error: unknown): boolean {
  // reg.exe returns 1 for a missing key/value (and for other failures). Only treat
  // its explicit not-found diagnostic as absent; surface access/launch failures.
  return error instanceof Error && 'stderr' in error
    && /unable to find|cannot find|not found|finner ikke|kan ikke finne/i.test(String(error.stderr));
}

function status(ctx: IntegrationContext, enabled: boolean, detail?: string): IntegrationStatus {
  const unavailable = integrationUnavailableReason(ctx);
  return { id: 'explorer-menu', enabled, available: !unavailable, ...(unavailable || detail ? { detail: unavailable ?? detail } : {}) };
}

export async function getExplorerMenuStatus(ctx: IntegrationContext): Promise<IntegrationStatus> {
  if (integrationUnavailableReason(ctx)) return status(ctx, false);
  try {
    const plan = planExplorerMenu(ctx);
    const actual = await Promise.all(plan.map(queryValue));
    const enabled = plan.every((value, index) => actual[index] === value.value);
    const partial = !enabled && actual.some((value) => value !== undefined);
    return status(ctx, enabled, partial ? 'The Explorer menu is incomplete or points to another installation; enable it to repair.' : undefined);
  } catch (error) {
    return status(ctx, false, `Could not read the Explorer menu: ${String(error)}`);
  }
}

export async function enableExplorerMenu(ctx: IntegrationContext): Promise<IntegrationStatus> {
  if (integrationUnavailableReason(ctx)) return status(ctx, false);
  try {
    for (const args of planExplorerRegistryCommands(ctx, true)) {
      await execFileAsync(REG_EXE, args, { windowsHide: true, encoding: 'utf8' });
    }
    return getExplorerMenuStatus(ctx);
  } catch (error) {
    return status(ctx, false, `Could not enable the Explorer menu: ${String(error)}`);
  }
}

export async function disableExplorerMenu(ctx: IntegrationContext): Promise<IntegrationStatus> {
  if (integrationUnavailableReason(ctx)) return status(ctx, false);
  try {
    for (const args of planExplorerRegistryCommands(ctx, false)) {
      try {
        await execFileAsync(REG_EXE, args, { windowsHide: true, encoding: 'utf8' });
      } catch (error) {
        if (!isMissingRegistryValue(error)) throw error;
      }
    }
    return getExplorerMenuStatus(ctx);
  } catch (error) {
    const current = await getExplorerMenuStatus(ctx);
    return { ...current, detail: `Could not disable the Explorer menu: ${String(error)}` };
  }
}
