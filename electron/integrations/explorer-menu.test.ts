import { describe, expect, it } from 'vitest';
import { EXPLORER_MENU_KEYS, integrationUnavailableReason, planExplorerMenu, planExplorerRegistryCommands } from './explorer-menu';
import type { IntegrationContext } from './explorer-menu';

const ctx: IntegrationContext = {
  exePath: 'C:\\Program Files\\Lookout\\Lookout.exe', userDataDir: 'C:\\Data', nativeDir: 'C:\\Native', isPackaged: true,
};

describe('Explorer registry plan (no registry access)', () => {
  it('registers exactly three current-user menus with the correct Shell placeholders', () => {
    const plan = planExplorerMenu(ctx);
    expect(plan).toHaveLength(9);
    for (const key of EXPLORER_MENU_KEYS) {
      expect(plan).toContainEqual({ key, name: null, value: 'Open in Lookout' });
      expect(plan).toContainEqual({ key, name: 'Icon', value: ctx.exePath });
      expect(plan).toContainEqual({ key: `${key}\\command`, name: null, value: `"${ctx.exePath}" -d "${key.includes('Background') ? '%V' : '%1'}"` });
      expect(key).toMatch(/^HKCU\\Software\\Classes\\/);
    }
  });

  it('uses reg.exe add arguments with literal REG_SZ data', () => {
    const commands = planExplorerRegistryCommands(ctx, true);
    expect(commands[0]).toEqual(['add', EXPLORER_MENU_KEYS[0], '/ve', '/t', 'REG_SZ', '/d', 'Open in Lookout', '/f']);
    expect(commands[1]).toEqual(['add', EXPLORER_MENU_KEYS[0], '/v', 'Icon', '/t', 'REG_SZ', '/d', ctx.exePath, '/f']);
    expect(commands.every((args) => args[0] === 'add' && args.includes('REG_SZ'))).toBe(true);
  });

  it('deletes only the owned menu roots', () => {
    expect(planExplorerRegistryCommands(ctx, false)).toEqual(EXPLORER_MENU_KEYS.map((key) => ['delete', key, '/f']));
  });

  it('includes the application path for an explicitly enabled dev install', () => {
    const dev = { ...ctx, isPackaged: false, exePath: 'D:\\Electron\\electron.exe', appPath: 'D:\\My App' };
    expect(planExplorerMenu(dev)[2].value).toBe('"D:\\Electron\\electron.exe" "D:\\My App" -d "%1"');
    expect(integrationUnavailableReason(dev, { LOOKOUT_DEV_INTEGRATIONS: '1' }, 'win32')).toBeUndefined();
  });

  it('guards platform, packaged/dev status and missing app paths', () => {
    expect(integrationUnavailableReason(ctx, {}, 'linux')).toContain('Windows');
    expect(integrationUnavailableReason(ctx, {}, 'win32')).toBeUndefined();
    expect(integrationUnavailableReason({ ...ctx, isPackaged: false }, {}, 'win32')).toContain('packaged');
    expect(integrationUnavailableReason({ ...ctx, isPackaged: false }, { LOOKOUT_DEV_INTEGRATIONS: 'true' }, 'win32')).toContain('packaged');
    expect(integrationUnavailableReason({ ...ctx, isPackaged: false }, { LOOKOUT_DEV_INTEGRATIONS: '1' }, 'win32')).toContain('appPath');
    expect(() => planExplorerMenu({ ...ctx, isPackaged: false })).toThrow('appPath');
  });
});
