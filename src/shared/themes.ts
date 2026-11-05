// Dark variants of the Lookout window: Night is the darkest, Dusk a little lighter,
// Slate (cool) and Ash (warm) about equally light. Each one has a
// matching terminal color scheme in color-schemes.ts. The CSS tokens live in
// src/styles/tokens.css (`:root[data-theme='dark'][data-dark-theme='…']`).

export const DARK_THEMES = ['night', 'dusk', 'slate', 'ash'] as const;
export type DarkTheme = (typeof DARK_THEMES)[number];
export const DEFAULT_DARK_THEME: DarkTheme = 'night';

export interface DarkThemeInfo {
  id: DarkTheme;
  label: string;
  description: string;
  /** Matching terminal color scheme. */
  scheme: string;
  /** Window background (--bg). */
  background: string;
  /** Sidebar and title strip (--chrome); also the native caption buttons. */
  chrome: string;
  /** Selected rows (--surface-2). */
  surface: string;
  /** Glyph colour of the native caption buttons. */
  symbol: string;
}

export const DARK_THEME_INFO: Record<DarkTheme, DarkThemeInfo> = {
  night: { id: 'night', label: 'Night', description: 'Near-black', scheme: 'Lookout Night', background: '#0b0d11', chrome: '#0e1115', surface: '#191e26', symbol: '#a7b0be' },
  dusk: { id: 'dusk', label: 'Dusk', description: 'A step lighter', scheme: 'Lookout Dusk', background: '#16191e', chrome: '#1a1d23', surface: '#252a32', symbol: '#aeb7c4' },
  slate: { id: 'slate', label: 'Slate', description: 'Cool blue-grey', scheme: 'Lookout Slate', background: '#22272e', chrome: '#272d35', surface: '#343a43', symbol: '#b1bbc7' },
  ash: { id: 'ash', label: 'Ash', description: 'Warm charcoal', scheme: 'Lookout Ash', background: '#262624', chrome: '#2b2b29', surface: '#373733', symbol: '#bcb7ac' },
};

export const LIGHT_CHROME = { background: '#fbfbfa', chrome: '#f3f3f1', symbol: '#3d4350' };

/** The Lookout dark schemes follow the dark theme when it changes; any other scheme is the user's own pick. */
export function isLookoutDarkScheme(name: string): boolean {
  const key = name.trim().toLowerCase();
  return DARK_THEMES.some((theme) => DARK_THEME_INFO[theme].scheme.toLowerCase() === key);
}
