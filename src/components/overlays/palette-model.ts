// Palette scope <-> store state. The store only knows four modes, so the
// workspace and folder scopes are kept as a prefix on an 'all' query
// ({ mode: 'all', query: '#api' }).

import type { PaletteMode } from '../../state/store';

export type PaletteScope = 'all' | 'commands' | 'profiles' | 'tabs' | 'workspaces' | 'directories';

export interface PaletteInput {
  scope: PaletteScope;
  text: string;
}

export const SCOPE_PREFIX: Partial<Record<PaletteScope, string>> = {
  commands: '>',
  profiles: '@',
  workspaces: '#',
  directories: ':',
};

const PREFIX_SCOPE: Record<string, PaletteScope> = {
  '>': 'commands',
  '@': 'profiles',
  '#': 'workspaces',
  ':': 'directories',
};

export const SCOPE_LABEL: Record<PaletteScope, string> = {
  all: 'All',
  commands: 'Commands',
  profiles: 'Profiles',
  tabs: 'Tabs',
  workspaces: 'Workspaces',
  directories: 'Folders',
};

export function parsePalette(palette: { mode: PaletteMode; query: string }): PaletteInput {
  if (palette.mode !== 'all') {
    return { scope: palette.mode, text: palette.query };
  }
  const scope = PREFIX_SCOPE[palette.query.charAt(0)];
  return scope ? { scope, text: palette.query.slice(1) } : { scope: 'all', text: palette.query };
}

export function serializePalette(input: PaletteInput): { mode: PaletteMode; query: string } {
  switch (input.scope) {
    case 'all':
    case 'commands':
    case 'profiles':
    case 'tabs':
      return { mode: input.scope, query: input.text };
    case 'workspaces':
    case 'directories':
      return { mode: 'all', query: `${SCOPE_PREFIX[input.scope]}${input.text}` };
  }
}

/** Applies a new input value: a prefix typed into an empty input switches scope. */
export function applyInput(current: PaletteInput, value: string): PaletteInput {
  const scope = PREFIX_SCOPE[value.charAt(0)];
  if (scope && !current.text) {
    return { scope, text: value.slice(1) };
  }
  return { scope: current.scope, text: value };
}
