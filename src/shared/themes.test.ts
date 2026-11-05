import { describe, expect, it } from 'vitest';

import { findScheme, isLightScheme } from './color-schemes';
import { sanitizeSettings } from './settings-defaults';
import { DARK_THEME_INFO, DARK_THEMES, isLookoutDarkScheme } from './themes';

describe('dark themes', () => {
  it('pair every window theme with a dark terminal scheme of the same background', () => {
    for (const theme of DARK_THEMES) {
      const info = DARK_THEME_INFO[theme];
      const scheme = findScheme(info.scheme);
      expect(scheme, info.scheme).toBeDefined();
      expect(scheme!.background).toBe(info.background);
      expect(isLightScheme(scheme!)).toBe(false);
    }
  });

  it('are all lighter than Night, and Slate and Ash lighter than Dusk', () => {
    const luminance = (theme: keyof typeof DARK_THEME_INFO) => {
      const hex = DARK_THEME_INFO[theme].background;
      const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(luminance('dusk')).toBeGreaterThan(luminance('night'));
    expect(luminance('slate')).toBeGreaterThan(luminance('dusk'));
    expect(luminance('ash')).toBeGreaterThan(luminance('dusk'));
  });

  it('recognise only the Lookout dark schemes as theme-following', () => {
    expect(isLookoutDarkScheme('Lookout Night')).toBe(true);
    expect(isLookoutDarkScheme(' lookout slate ')).toBe(true);
    expect(isLookoutDarkScheme('Lookout Day')).toBe(false);
    expect(isLookoutDarkScheme('Dracula')).toBe(false);
  });

  it('sanitize the darkTheme setting', () => {
    expect(sanitizeSettings({}).settings.darkTheme).toBe('night');
    expect(sanitizeSettings({ darkTheme: 'ash' }).settings.darkTheme).toBe('ash');
    const invalid = sanitizeSettings({ darkTheme: 'neon' });
    expect(invalid.settings.darkTheme).toBe('night');
    expect(invalid.warnings.join('\n')).toMatch(/darkTheme/);
  });
});
