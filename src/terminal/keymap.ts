// Keyboard shortcuts: chord parsing/normalisation, the default keymap, and
// matching DOM keyboard events against it.
//
// Rules that keep terminal apps working:
// - AltGr (reported by Windows as Ctrl+Alt) never matches a shortcut, so
//   characters like @ { [ ] } \ $ on Nordic/German layouts always reach the shell.
// - Plain Ctrl+<letter> is never bound by default except copy/paste, which
//   only act when they have something to do (selection / clipboard text).
// - `+`/`=` normalise to `plus` and `-`/`_` to `minus`, like Windows Terminal.

import type { CommandId } from '../shared/commands';
import type { KeybindingEntry } from '../shared/settings';

export interface ResolvedBinding {
  chord: string;
  command: CommandId;
  args?: Record<string, string | number | boolean>;
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'win'] as const;

const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctl: 'ctrl',
  option: 'alt',
  meta: 'win',
  super: 'win',
  cmd: 'win',
  command: 'win',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  '+': 'plus',
  '=': 'plus',
  '-': 'minus',
  _: 'minus',
  ' ': 'space',
  spacebar: 'space',
  backtick: '`',
  grave: '`',
  comma: ',',
  period: '.',
  semicolon: ';',
  slash: '/',
  backslash: '\\',
};

/** Normalises a user-written chord (`Ctrl+Shift+T`, `alt+shift+-`) to canonical form. */
export function normalizeChord(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }

  // Split on '+' but keep a trailing '+' as the key ("ctrl++").
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '+' && current) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }

  const modifiers = new Set<string>();
  let key = '';
  for (const rawPart of parts) {
    const part = KEY_ALIASES[rawPart.trim()] ?? rawPart.trim();
    if ((MODIFIER_ORDER as readonly string[]).includes(part)) {
      modifiers.add(part);
    } else {
      key = part;
    }
  }

  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].filter(Boolean).join('+');
}

const CODE_NAMES: Record<string, string> = {
  Backquote: '`',
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  NumpadAdd: 'numpad_plus',
  NumpadSubtract: 'numpad_minus',
  NumpadMultiply: 'numpad_multiply',
  NumpadDivide: 'numpad_divide',
  NumpadDecimal: 'numpad_decimal',
  ContextMenu: 'menu',
  Pause: 'pause',
};

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  getModifierState?(key: string): boolean;
}

/** The canonical key name of an event (without modifiers), or '' for modifier-only presses. */
export function eventKeyName(event: KeyLike): string {
  const { key, code } = event;
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'OS'].includes(key)) {
    return '';
  }

  if (/^Digit\d$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad\d$/.test(code)) {
    return `numpad${code.slice(6)}`;
  }
  if (/^F\d{1,2}$/.test(code)) {
    return code.toLowerCase();
  }
  if (CODE_NAMES[code]) {
    return CODE_NAMES[code];
  }

  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (/^[a-z]$/.test(lower)) {
      return lower;
    }
    if (KEY_ALIASES[lower]) {
      return KEY_ALIASES[lower];
    }
    // Non-Latin layouts: fall back to the physical letter position.
    if (/^Key[A-Z]$/.test(code)) {
      return code.slice(3).toLowerCase();
    }
    return lower;
  }

  return KEY_ALIASES[key.toLowerCase()] ?? key.toLowerCase();
}

export function isAltGr(event: KeyLike): boolean {
  return Boolean(event.getModifierState?.('AltGraph')) || (event.ctrlKey && event.altKey && !event.metaKey && event.key.length === 1 && !/^[a-z0-9]$/i.test(event.key));
}

export function eventChord(event: KeyLike): string {
  const name = eventKeyName(event);
  if (!name) {
    return '';
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  if (event.metaKey) modifiers.push('win');
  return [...modifiers, name].join('+');
}

/** Default keymap: Windows Terminal conventions, adjusted to stay AltGr-safe. */
export const DEFAULT_KEYBINDINGS: KeybindingEntry[] = [
  { keys: 'ctrl+c', command: 'copy' },
  { keys: 'ctrl+shift+c', command: 'copy' },
  { keys: 'ctrl+insert', command: 'copy' },
  { keys: 'ctrl+v', command: 'paste' },
  { keys: 'ctrl+shift+v', command: 'paste' },
  { keys: 'shift+insert', command: 'paste' },
  { keys: 'ctrl+shift+a', command: 'selectAll' },
  { keys: 'ctrl+shift+f', command: 'find' },
  { keys: 'ctrl+shift+k', command: 'clearBuffer' },

  { keys: 'ctrl+shift+t', command: 'newTab' },
  { keys: 'ctrl+shift+space', command: 'newTabMenu' },
  { keys: 'ctrl+shift+1', command: 'newTabProfileIndex', args: { index: 0 } },
  { keys: 'ctrl+shift+2', command: 'newTabProfileIndex', args: { index: 1 } },
  { keys: 'ctrl+shift+3', command: 'newTabProfileIndex', args: { index: 2 } },
  { keys: 'ctrl+shift+4', command: 'newTabProfileIndex', args: { index: 3 } },
  { keys: 'ctrl+shift+5', command: 'newTabProfileIndex', args: { index: 4 } },
  { keys: 'ctrl+shift+6', command: 'newTabProfileIndex', args: { index: 5 } },
  { keys: 'ctrl+shift+7', command: 'newTabProfileIndex', args: { index: 6 } },
  { keys: 'ctrl+shift+8', command: 'newTabProfileIndex', args: { index: 7 } },
  { keys: 'ctrl+shift+9', command: 'newTabProfileIndex', args: { index: 8 } },
  { keys: 'ctrl+shift+d', command: 'duplicateTab' },
  { keys: 'ctrl+shift+w', command: 'closePane' },
  { keys: 'ctrl+shift+n', command: 'newWindow' },
  { keys: 'ctrl+shift+r', command: 'reopenClosedTab' },
  { keys: 'ctrl+tab', command: 'nextTab' },
  { keys: 'ctrl+shift+tab', command: 'prevTab' },
  { keys: 'ctrl+pagedown', command: 'nextTab' },
  { keys: 'ctrl+pageup', command: 'prevTab' },
  { keys: 'ctrl+1', command: 'switchToTab', args: { index: 0 } },
  { keys: 'ctrl+2', command: 'switchToTab', args: { index: 1 } },
  { keys: 'ctrl+3', command: 'switchToTab', args: { index: 2 } },
  { keys: 'ctrl+4', command: 'switchToTab', args: { index: 3 } },
  { keys: 'ctrl+5', command: 'switchToTab', args: { index: 4 } },
  { keys: 'ctrl+6', command: 'switchToTab', args: { index: 5 } },
  { keys: 'ctrl+7', command: 'switchToTab', args: { index: 6 } },
  { keys: 'ctrl+8', command: 'switchToTab', args: { index: 7 } },
  { keys: 'ctrl+9', command: 'switchToTab', args: { index: -1 } },

  { keys: 'alt+shift+plus', command: 'splitRight' },
  { keys: 'alt+shift+minus', command: 'splitDown' },
  { keys: 'alt+shift+d', command: 'splitAuto' },
  { keys: 'alt+left', command: 'focusPane', args: { direction: 'left' } },
  { keys: 'alt+right', command: 'focusPane', args: { direction: 'right' } },
  { keys: 'alt+up', command: 'focusPane', args: { direction: 'up' } },
  { keys: 'alt+down', command: 'focusPane', args: { direction: 'down' } },
  { keys: 'alt+shift+left', command: 'resizePane', args: { direction: 'left' } },
  { keys: 'alt+shift+right', command: 'resizePane', args: { direction: 'right' } },
  { keys: 'alt+shift+up', command: 'resizePane', args: { direction: 'up' } },
  { keys: 'alt+shift+down', command: 'resizePane', args: { direction: 'down' } },
  { keys: 'ctrl+shift+z', command: 'togglePaneZoom' },
  { keys: 'ctrl+shift+e', command: 'equalizePanes' },

  { keys: 'shift+pageup', command: 'scrollPageUp' },
  { keys: 'shift+pagedown', command: 'scrollPageDown' },
  { keys: 'ctrl+shift+up', command: 'scrollUp' },
  { keys: 'ctrl+shift+down', command: 'scrollDown' },
  { keys: 'ctrl+shift+home', command: 'scrollToTop' },
  { keys: 'ctrl+shift+end', command: 'scrollToBottom' },
  { keys: 'ctrl+up', command: 'prevCommand' },
  { keys: 'ctrl+down', command: 'nextCommand' },

  { keys: 'ctrl+plus', command: 'fontSizeIncrease' },
  { keys: 'ctrl+minus', command: 'fontSizeDecrease' },
  { keys: 'ctrl+0', command: 'fontSizeReset' },
  { keys: 'ctrl+numpad_plus', command: 'fontSizeIncrease' },
  { keys: 'ctrl+numpad_minus', command: 'fontSizeDecrease' },

  { keys: 'ctrl+shift+p', command: 'commandPalette' },
  { keys: 'ctrl+comma', command: 'openSettings' },
  { keys: 'ctrl+shift+b', command: 'toggleSidebar' },
  { keys: 'f11', command: 'toggleFullscreen' },
  { keys: 'ctrl+shift+f12', command: 'toggleDevTools' },
];

/** Merges user entries over the defaults. `command: null` removes a default chord. */
export function resolveKeymap(userBindings: KeybindingEntry[], isCommand: (value: string) => value is CommandId): Map<string, ResolvedBinding> {
  const map = new Map<string, ResolvedBinding>();

  const apply = (entry: KeybindingEntry) => {
    const chord = normalizeChord(entry.keys);
    if (!chord) {
      return;
    }

    if (entry.command === null) {
      map.delete(chord);
      return;
    }

    if (isCommand(entry.command)) {
      map.set(chord, { chord, command: entry.command, args: entry.args });
    }
  };

  DEFAULT_KEYBINDINGS.forEach(apply);
  userBindings.forEach(apply);
  return map;
}

/** Human-readable label for menus: `Ctrl+Shift+T`. */
export function formatChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => {
      switch (part) {
        case 'ctrl':
          return 'Ctrl';
        case 'alt':
          return 'Alt';
        case 'shift':
          return 'Shift';
        case 'win':
          return 'Win';
        case 'plus':
          return '+';
        case 'minus':
          return '-';
        case 'pageup':
          return 'PgUp';
        case 'pagedown':
          return 'PgDn';
        case 'up':
          return '↑';
        case 'down':
          return '↓';
        case 'left':
          return '←';
        case 'right':
          return '→';
        case 'comma':
          return ',';
        default:
          return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
      }
    })
    .join('+');
}

/** Finds the chord bound to a command (first match), for display. */
export function chordForCommand(keymap: Map<string, ResolvedBinding>, command: CommandId, args?: Record<string, unknown>): string | null {
  for (const binding of keymap.values()) {
    if (binding.command !== command) {
      continue;
    }
    if (args && binding.args && Object.entries(args).some(([key, value]) => binding.args?.[key] !== value)) {
      continue;
    }
    return binding.chord;
  }
  return null;
}
