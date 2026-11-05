// Chord lookup for menus and the palette.
//
// Stricter than `chordForCommand` in keymap.ts, which matches an args-less
// binding for any args (so "Split right with Ubuntu" would show the plain
// split chord) and an args binding for an args-less query (a user's
// `splitRight {profile}` chord would label plain "Split pane right"). Here a
// chord is shown only when the binding's args are exactly what the entry runs.

import type { CommandId } from '../../shared/commands';
import { getKeymap } from '../../state/actions';
import { formatChord } from '../../terminal/keymap';

type Args = Record<string, string | number | boolean>;

export function chordFor(command: CommandId, args?: Args): string | undefined {
  const wanted = Object.entries(args ?? {});
  for (const binding of getKeymap().values()) {
    if (binding.command !== command) {
      continue;
    }
    const bound = Object.entries(binding.args ?? {});
    if (bound.length === wanted.length && wanted.every(([key, value]) => binding.args?.[key] === value)) {
      return binding.chord;
    }
  }
  return undefined;
}

/** Display label (`Ctrl+Shift+T`) for a command's chord, if bound. */
export function chordLabel(command: CommandId, args?: Args): string | undefined {
  const chord = chordFor(command, args);
  return chord ? formatChord(chord) : undefined;
}

/** Canonical chord split into display keys: `alt+shift+plus` → ['Alt', 'Shift', '+']. */
export function chordKeys(chord: string): string[] {
  return chord.split('+').map((part) => formatChord(part));
}
