import { describe, expect, it } from 'vitest';

import { buildFontInventory, fontFamilyFromRegistryName, inventoryHasFont, isFontInstalled, listLocalFonts, parseFontRegistryLine } from './fonts';

describe('font registry parsing', () => {
  it('parses reg query lines, including font collections', () => {
    expect(parseFontRegistryLine('    MesloLGM Nerd Font Bold Italic (TrueType)    REG_SZ    C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Fonts\\x.ttf')).toEqual(['MesloLGM Nerd Font Bold Italic']);
    expect(parseFontRegistryLine('    Cambria & Cambria Math (TrueType)    REG_SZ    cambria.ttc')).toEqual(['Cambria', 'Cambria Math']);
    expect(parseFontRegistryLine('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')).toEqual([]);
    expect(parseFontRegistryLine('')).toEqual([]);
  });

  it('reduces registry names to CSS family names (RIBBI suffixes only)', () => {
    expect(fontFamilyFromRegistryName('MesloLGM Nerd Font Regular')).toBe('MesloLGM Nerd Font');
    expect(fontFamilyFromRegistryName('MesloLGM Nerd Font Bold Italic')).toBe('MesloLGM Nerd Font');
    expect(fontFamilyFromRegistryName('Cascadia Mono Regular')).toBe('Cascadia Mono');
    expect(fontFamilyFromRegistryName('Consolas')).toBe('Consolas');
    expect(fontFamilyFromRegistryName('Segoe UI Semibold')).toBe('Segoe UI Semibold');
    expect(fontFamilyFromRegistryName('Arial Black')).toBe('Arial Black');
  });

  it('matches faces case-insensitively by family or full name', () => {
    const inventory = buildFontInventory(['MesloLGM Nerd Font Regular', 'MesloLGM Nerd Font Bold', 'Consolas', 'Cascadia Mono Regular']);
    expect(inventory.families).toEqual(['Cascadia Mono', 'Consolas', 'MesloLGM Nerd Font']);
    expect(inventoryHasFont(inventory, 'mesloLGM nerd font')).toBe(true);
    expect(inventoryHasFont(inventory, '"Cascadia Mono"')).toBe(true);
    expect(inventoryHasFont(inventory, 'Cascadia Mono Regular')).toBe(true);
    expect(inventoryHasFont(inventory, 'monospace')).toBe(true);
    expect(inventoryHasFont(inventory, 'Comic Mono')).toBe(false);
    expect(inventoryHasFont(inventory, '')).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('installed fonts (live)', () => {
  it('lists families from the registry and caches them', async () => {
    const fonts = await listLocalFonts();
    expect(fonts.length).toBeGreaterThan(10);
    expect(fonts).toContain('Consolas');
    expect(fonts.some((font) => / Regular$/.test(font))).toBe(false);
    expect(await isFontInstalled('Consolas')).toBe(true);
    expect(await isFontInstalled('Definitely Not A Font 123')).toBe(false);
  });
});
