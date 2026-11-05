import { describe, expect, it } from 'vitest';
import { BUILTIN_SCHEMES, findScheme, isLightScheme, parseItermColors, parseWtSchemes } from './color-schemes';

describe('color schemes', () => {
  it('ships every requested palette with complete hexadecimal color values', () => {
    const names = ['Campbell', 'Campbell Powershell', 'Vintage', 'One Half Dark', 'One Half Light', 'Solarized Dark', 'Solarized Light',
      'Tango Dark', 'Tango Light', 'Ottosson', 'Dark+', 'CGA', 'IBM 5153', 'Dracula', 'Catppuccin Mocha', 'Catppuccin Latte',
      'Tokyo Night', 'Gruvbox Dark', 'Nord', 'GitHub Dark', 'GitHub Light', 'Lookout Night', 'Lookout Dusk', 'Lookout Slate', 'Lookout Ash',
      'Lookout Day'];
    expect(BUILTIN_SCHEMES.map((scheme) => scheme.name)).toEqual(names);
    for (const scheme of BUILTIN_SCHEMES) {
      expect(Object.keys(scheme)).toHaveLength(21);
      for (const [key, value] of Object.entries(scheme)) if (key !== 'name') expect(value).toMatch(/^#[\da-f]{6}$/);
    }
    expect(findScheme('Campbell')?.red).toBe('#c50f1f');
    expect(findScheme('CGA')?.yellow).toBe('#aa5500');
    expect(findScheme('IBM 5153')?.yellow).toBe('#c47e00');
    expect(findScheme('Lookout Night')).toMatchObject({ background: '#0b0d11', foreground: '#d6dde8', cursorColor: '#f0883e', selectionBackground: '#2a3140' });
  });

  it('resolves case-insensitive custom overrides and classifies by background luminance', () => {
    const custom = { ...BUILTIN_SCHEMES[0], name: 'Campbell', background: '#ffffff' };
    expect(findScheme(' campBELL ', [custom])).toBe(custom);
    expect(findScheme('missing')).toBeUndefined();
    expect(isLightScheme(findScheme('Lookout Day')!)).toBe(true);
    expect(isLightScheme(findScheme('Catppuccin Latte')!)).toBe(true);
    expect(isLightScheme(findScheme('Lookout Night')!)).toBe(false);
    expect(isLightScheme(findScheme('Solarized Dark')!)).toBe(false);
    expect(isLightScheme({ ...custom, background: 'invalid' })).toBe(false);
  });

  it('accepts WT settings, arrays, and individual palettes while validating and normalizing colors', () => {
    const original = { ...BUILTIN_SCHEMES[0], name: 'Custom', red: '#AbC' };
    expect(parseWtSchemes({ schemes: [null, {}, { ...original, green: 'bad' }, original] })).toEqual([{ ...original, red: '#aabbcc' }]);
    expect(parseWtSchemes(original)).toHaveLength(1);
    expect(parseWtSchemes([original, { ...original, background: '#ffffff' }])).toHaveLength(1);
    expect(parseWtSchemes(null)).toEqual([]);
  });

  it('reads iTerm plist float RGB, scientific notation, arbitrary component order, and optional colors', () => {
    const rgb = (key: string, r: number, g: number, b: number) => `<key>${key}</key><dict><key>Blue Component</key><real>${b}</real><key>Red Component</key><real>${r}</real><key>Green Component</key><real>${g}</real><key>Alpha Component</key><real>1</real><key>Color Space</key><string>sRGB</string></dict>`;
    const ansi = Array.from({ length: 16 }, (_, index) => rgb(`Ansi ${index} Color`, index / 15, 0.5, 0));
    const xml = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
${rgb('Background Color', 0.01, 0, 0)}${rgb('Foreground Color', 1, 1, 1)}${rgb('Cursor Color', 1, 0.5, 0.25)}${rgb('Selection Color', 0.2, 0.3, 0.4)}${ansi.join('')}
</dict></plist>`;
    const scheme = parseItermColors(xml.replace('<real>0.01</real>', '<real>1e-2</real>'), 'Imported');
    expect(scheme).toMatchObject({ name: 'Imported', background: '#030000', foreground: '#ffffff', cursorColor: '#ff8040', selectionBackground: '#334d66', black: '#008000', brightWhite: '#ff8000' });
    expect(parseItermColors(`<dict>${rgb('Background Color', 0, 0, 0)}${rgb('Foreground Color', 1, 1, 1)}</dict>`, 'Minimal').cursorColor).toBe('#ffffff');
    expect(() => parseItermColors('<plist><dict/></plist>', 'Invalid')).toThrow(/missing background/);
  });
});
