// Key recorders: turn a keydown into a keymap chord (`ctrl+shift+t`) or an Electron
// global-shortcut accelerator (`Super+\``), and format both for display.

import { eventChord, formatChord, isAltGr, normalizeChord, type KeyLike } from '../../terminal/keymap';

export type CaptureResult =
  | { kind: 'pending' }
  | { kind: 'cancel' }
  | { kind: 'error'; message: string }
  | { kind: 'value'; value: string };

export const ALTGR_MESSAGE = 'AltGr types characters like @ { [ ] } \\ $, so it can’t be a shortcut. Try Ctrl+Shift or Alt.';

const TYPING_KEYS = new Set(['space', 'enter', 'tab', 'backspace', 'delete']);

/** Display parts for a keymap chord: `ctrl+shift+plus` → `['Ctrl', 'Shift', '+']`. */
export function chordParts(chord: string): string[] {
  return normalizeChord(chord)
    .split('+')
    .filter(Boolean)
    .map((part) => formatChord(part));
}

/** Keybinding recorder. Esc cancels; AltGr and plain typing keys are rejected. */
export function captureChord(event: KeyLike): CaptureResult {
  if (event.key === 'Escape') {
    return { kind: 'cancel' };
  }
  if (isAltGr(event)) {
    return { kind: 'error', message: ALTGR_MESSAGE };
  }

  const chord = normalizeChord(eventChord(event));
  if (!chord) {
    return { kind: 'pending' };
  }

  const parts = chord.split('+');
  const key = parts[parts.length - 1];
  const commandModifiers = parts.slice(0, -1).filter((part) => part !== 'shift');
  if (!commandModifiers.length && (key.length === 1 || TYPING_KEYS.has(key) || key.startsWith('numpad'))) {
    return { kind: 'error', message: `${chordParts(chord).join('+')} types text in the shell. Add Ctrl or Alt.` };
  }
  return { kind: 'value', value: chord };
}

// ---- Electron accelerators --------------------------------------------------

const ACCELERATOR_CODES: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'CapsLock', 'NumLock', 'ScrollLock']);

/** Electron key code for the physical key (US positions, so it is layout independent). */
function acceleratorKey(event: KeyLike): string {
  const { code } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return ACCELERATOR_CODES[code] ?? '';
}

/**
 * Global-hotkey recorder. Produces e.g. `Ctrl+Alt+Space` or `Super+\``.
 * Global hotkeys are registered by Electron, not matched by the renderer keymap, so
 * Ctrl+Alt+Space is fine here even though the keymap's AltGr heuristic rejects it.
 */
export function captureAccelerator(event: KeyLike): CaptureResult {
  if (event.key === 'Escape') {
    return { kind: 'cancel' };
  }
  if (event.code !== 'Space' && isAltGr(event)) {
    return { kind: 'error', message: ALTGR_MESSAGE };
  }
  if (MODIFIER_KEYS.has(event.key)) {
    return { kind: 'pending' };
  }

  const key = acceleratorKey(event);
  if (!key) {
    return { kind: 'error', message: 'That key can’t be used in a global hotkey.' };
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (!isFunctionKey && !modifiers.some((modifier) => modifier !== 'Shift')) {
    return { kind: 'error', message: 'Add Ctrl, Alt or Win: a global hotkey takes the key away from every app.' };
  }
  return { kind: 'value', value: [...modifiers, key].join('+') };
}

const ACCELERATOR_MODIFIERS: Record<string, { label: string; chord: string }> = {
  ctrl: { label: 'Ctrl', chord: 'ctrl' },
  control: { label: 'Ctrl', chord: 'ctrl' },
  commandorcontrol: { label: 'Ctrl', chord: 'ctrl' },
  cmdorctrl: { label: 'Ctrl', chord: 'ctrl' },
  alt: { label: 'Alt', chord: 'alt' },
  option: { label: 'Alt', chord: 'alt' },
  altgr: { label: 'AltGr', chord: 'altgr' },
  shift: { label: 'Shift', chord: 'shift' },
  super: { label: 'Win', chord: 'win' },
  meta: { label: 'Win', chord: 'win' },
  command: { label: 'Win', chord: 'win' },
  cmd: { label: 'Win', chord: 'win' },
};

const ACCELERATOR_TO_CHORD_KEY: Record<string, string> = {
  plus: 'plus',
  space: 'space',
  return: 'enter',
  enter: 'enter',
  esc: 'escape',
  escape: 'escape',
  numadd: 'numpad_plus',
  numsub: 'numpad_minus',
  nummult: 'numpad_multiply',
  numdiv: 'numpad_divide',
  numdec: 'numpad_decimal',
};

function splitAccelerator(accelerator: string): string[] {
  // `Ctrl++` is not valid Electron syntax (it uses `Plus`), but tolerate it.
  const trimmed = accelerator.trim();
  const parts = trimmed.replace(/\+\+$/, '+Plus').split('+').map((part) => part.trim());
  return parts.filter(Boolean);
}

/** Display parts: `Super+\`` → `['Win', '`']`. */
export function acceleratorParts(accelerator: string): string[] {
  return splitAccelerator(accelerator).map((part) => {
    const modifier = ACCELERATOR_MODIFIERS[part.toLowerCase()];
    if (modifier) return modifier.label;
    if (part.toLowerCase() === 'plus') return '+';
    if (/^num\d$/i.test(part)) return `Num ${part.slice(3)}`;
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
  });
}

/** Keymap chord for an accelerator, to detect clashes with in-app shortcuts. */
export function acceleratorToChord(accelerator: string): string {
  const parts = splitAccelerator(accelerator);
  if (!parts.length) return '';
  const key = parts[parts.length - 1].toLowerCase();
  const modifiers = parts.slice(0, -1).map((part) => ACCELERATOR_MODIFIERS[part.toLowerCase()]?.chord ?? part.toLowerCase());
  const chordKey = ACCELERATOR_TO_CHORD_KEY[key] ?? (/^num\d$/.test(key) ? `numpad${key.slice(3)}` : key);
  return normalizeChord([...modifiers, chordKey].join('+'));
}
