import type { ITheme } from '@xterm/xterm';

import { BUILTIN_SCHEMES } from '../shared/color-schemes';
import type { ColorScheme, LookoutSettings, ProfileDefinition } from '../shared/settings';
import { DARK_THEME_INFO } from '../shared/themes';

const FALLBACK_SCHEME: ColorScheme = {
  name: 'Lookout Night',
  foreground: '#d6dde8',
  background: '#0b0d11',
  cursorColor: '#f0883e',
  selectionBackground: '#2a3140',
  black: '#1b2029',
  red: '#f26d78',
  green: '#7fd18b',
  yellow: '#e8c26a',
  blue: '#6aa6f8',
  purple: '#b18cf2',
  cyan: '#5fcfd2',
  white: '#c9d1dd',
  brightBlack: '#5c6676',
  brightRed: '#ff8a93',
  brightGreen: '#9be3a5',
  brightYellow: '#f4d58c',
  brightBlue: '#8dbcff',
  brightPurple: '#c9adf7',
  brightCyan: '#86e1e3',
  brightWhite: '#f1f4f8',
};

export function allSchemes(settings: LookoutSettings): ColorScheme[] {
  const byName = new Map<string, ColorScheme>();
  for (const scheme of BUILTIN_SCHEMES ?? []) {
    byName.set(scheme.name.toLowerCase(), scheme);
  }
  for (const scheme of settings.schemes) {
    byName.set(scheme.name.toLowerCase(), scheme);
  }
  return [...byName.values()];
}

export function resolveScheme(settings: LookoutSettings, profile?: ProfileDefinition, appTheme: 'dark' | 'light' = 'dark'): ColorScheme {
  const name = profile?.colorScheme ?? settings.colorScheme;
  const schemes = allSchemes(settings);
  const found = schemes.find((scheme) => scheme.name.toLowerCase() === name.toLowerCase());
  if (found) {
    return found;
  }

  const fallbackName = appTheme === 'light' ? 'lookout day' : (DARK_THEME_INFO[settings.darkTheme]?.scheme ?? 'Lookout Night').toLowerCase();
  return schemes.find((scheme) => scheme.name.toLowerCase() === fallbackName) ?? FALLBACK_SCHEME;
}

function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return hex;
  }
  const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${match[1]}${value}`;
}

export function schemeToXtermTheme(scheme: ColorScheme): ITheme {
  return {
    background: scheme.background,
    foreground: scheme.foreground,
    cursor: scheme.cursorColor,
    cursorAccent: scheme.background,
    selectionBackground: withAlpha(scheme.selectionBackground, 0.85),
    selectionInactiveBackground: withAlpha(scheme.selectionBackground, 0.5),
    black: scheme.black,
    red: scheme.red,
    green: scheme.green,
    yellow: scheme.yellow,
    blue: scheme.blue,
    magenta: scheme.purple,
    cyan: scheme.cyan,
    white: scheme.white,
    brightBlack: scheme.brightBlack,
    brightRed: scheme.brightRed,
    brightGreen: scheme.brightGreen,
    brightYellow: scheme.brightYellow,
    brightBlue: scheme.brightBlue,
    brightMagenta: scheme.brightPurple,
    brightCyan: scheme.brightCyan,
    brightWhite: scheme.brightWhite,
    scrollbarSliderBackground: withAlpha(scheme.foreground, 0.12),
    scrollbarSliderHoverBackground: withAlpha(scheme.foreground, 0.22),
    scrollbarSliderActiveBackground: withAlpha(scheme.foreground, 0.3),
    // xterm only parses hex/rgb colours here ('transparent' renders as white).
    overviewRulerBorder: scheme.background,
  };
}

export function resolveAppTheme(settings: LookoutSettings): 'dark' | 'light' {
  if (settings.appTheme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return settings.appTheme;
}

const FONT_FALLBACK = '"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Symbol", "Segoe UI Emoji", monospace';

export function fontFamily(face: string): string {
  const trimmed = face.trim();
  if (!trimmed) {
    return FONT_FALLBACK;
  }
  const quoted = /[\s,]/.test(trimmed) && !/^["'].*["']$/.test(trimmed) ? `"${trimmed}"` : trimmed;
  return `${quoted}, ${FONT_FALLBACK}`;
}
