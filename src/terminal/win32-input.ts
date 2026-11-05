export interface KeyEventLike {
  type: 'keydown' | 'keyup' | 'keypress';
  key: string;
  code: string;
  keyCode: number;
  location: number;
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  getModifierState(key: string): boolean;
}

const RIGHT_ALT = 0x01;
const LEFT_ALT = 0x02;
const RIGHT_CTRL = 0x04;
const LEFT_CTRL = 0x08;
const SHIFT = 0x10;
const NUMLOCK = 0x20;
const SCROLLLOCK = 0x40;
const CAPSLOCK = 0x80;
const ENHANCED_KEY = 0x100;

interface KeyMapping {
  sc: number;
  vk: number;
  enhanced?: boolean;
  // Meta is a modifier too, but has no dwControlKeyState bit.
  modifier?: number;
}

// Set-1 make codes, without the E0 prefix: Windows carries that in ENHANCED_KEY.
// VK fallbacks for OEM punctuation assume a US layout. A real Windows keyCode
// takes precedence, so characters and VKs on Norwegian layouts are preserved.
const KEY_MAPPINGS: Record<string, KeyMapping> = {
  Escape: { sc: 0x01, vk: 0x1b },
  Minus: { sc: 0x0c, vk: 0xbd },
  Equal: { sc: 0x0d, vk: 0xbb },
  Backspace: { sc: 0x0e, vk: 0x08 },
  Tab: { sc: 0x0f, vk: 0x09 },
  KeyQ: { sc: 0x10, vk: 0x51 },
  KeyW: { sc: 0x11, vk: 0x57 },
  KeyE: { sc: 0x12, vk: 0x45 },
  KeyR: { sc: 0x13, vk: 0x52 },
  KeyT: { sc: 0x14, vk: 0x54 },
  KeyY: { sc: 0x15, vk: 0x59 },
  KeyU: { sc: 0x16, vk: 0x55 },
  KeyI: { sc: 0x17, vk: 0x49 },
  KeyO: { sc: 0x18, vk: 0x4f },
  KeyP: { sc: 0x19, vk: 0x50 },
  BracketLeft: { sc: 0x1a, vk: 0xdb },
  BracketRight: { sc: 0x1b, vk: 0xdd },
  Enter: { sc: 0x1c, vk: 0x0d },
  ControlLeft: { sc: 0x1d, vk: 0x11, modifier: LEFT_CTRL },
  KeyA: { sc: 0x1e, vk: 0x41 },
  KeyS: { sc: 0x1f, vk: 0x53 },
  KeyD: { sc: 0x20, vk: 0x44 },
  KeyF: { sc: 0x21, vk: 0x46 },
  KeyG: { sc: 0x22, vk: 0x47 },
  KeyH: { sc: 0x23, vk: 0x48 },
  KeyJ: { sc: 0x24, vk: 0x4a },
  KeyK: { sc: 0x25, vk: 0x4b },
  KeyL: { sc: 0x26, vk: 0x4c },
  Semicolon: { sc: 0x27, vk: 0xba },
  Quote: { sc: 0x28, vk: 0xde },
  Backquote: { sc: 0x29, vk: 0xc0 },
  ShiftLeft: { sc: 0x2a, vk: 0x10, modifier: SHIFT },
  Backslash: { sc: 0x2b, vk: 0xdc },
  KeyZ: { sc: 0x2c, vk: 0x5a },
  KeyX: { sc: 0x2d, vk: 0x58 },
  KeyC: { sc: 0x2e, vk: 0x43 },
  KeyV: { sc: 0x2f, vk: 0x56 },
  KeyB: { sc: 0x30, vk: 0x42 },
  KeyN: { sc: 0x31, vk: 0x4e },
  KeyM: { sc: 0x32, vk: 0x4d },
  Comma: { sc: 0x33, vk: 0xbc },
  Period: { sc: 0x34, vk: 0xbe },
  Slash: { sc: 0x35, vk: 0xbf },
  ShiftRight: { sc: 0x36, vk: 0x10, modifier: SHIFT },
  NumpadMultiply: { sc: 0x37, vk: 0x6a },
  AltLeft: { sc: 0x38, vk: 0x12, modifier: LEFT_ALT },
  Space: { sc: 0x39, vk: 0x20 },
  CapsLock: { sc: 0x3a, vk: 0x14 },
  NumLock: { sc: 0x45, vk: 0x90, enhanced: true },
  ScrollLock: { sc: 0x46, vk: 0x91 },
  NumpadSubtract: { sc: 0x4a, vk: 0x6d },
  NumpadAdd: { sc: 0x4e, vk: 0x6b },
  NumpadDecimal: { sc: 0x53, vk: 0x6e },
  IntlBackslash: { sc: 0x56, vk: 0xe2 },
  NumpadEqual: { sc: 0x59, vk: 0x92 },
  IntlRo: { sc: 0x73, vk: 0xe2 },
  IntlYen: { sc: 0x7d, vk: 0xdc },
  NumpadComma: { sc: 0x7e, vk: 0x6c },
  NumpadEnter: { sc: 0x1c, vk: 0x0d, enhanced: true },
  ControlRight: { sc: 0x1d, vk: 0x11, enhanced: true, modifier: RIGHT_CTRL },
  NumpadDivide: { sc: 0x35, vk: 0x6f, enhanced: true },
  PrintScreen: { sc: 0x37, vk: 0x2c, enhanced: true },
  AltRight: { sc: 0x38, vk: 0x12, enhanced: true, modifier: RIGHT_ALT },
  Home: { sc: 0x47, vk: 0x24, enhanced: true },
  ArrowUp: { sc: 0x48, vk: 0x26, enhanced: true },
  PageUp: { sc: 0x49, vk: 0x21, enhanced: true },
  ArrowLeft: { sc: 0x4b, vk: 0x25, enhanced: true },
  ArrowRight: { sc: 0x4d, vk: 0x27, enhanced: true },
  End: { sc: 0x4f, vk: 0x23, enhanced: true },
  ArrowDown: { sc: 0x50, vk: 0x28, enhanced: true },
  PageDown: { sc: 0x51, vk: 0x22, enhanced: true },
  Insert: { sc: 0x52, vk: 0x2d, enhanced: true },
  Delete: { sc: 0x53, vk: 0x2e, enhanced: true },
  MetaLeft: { sc: 0x5b, vk: 0x5b, enhanced: true, modifier: 0 },
  MetaRight: { sc: 0x5c, vk: 0x5c, enhanced: true, modifier: 0 },
  ContextMenu: { sc: 0x5d, vk: 0x5d, enhanced: true },
  // Pause uses an E1 sequence, not E0, and is not an enhanced key.
  Pause: { sc: 0x45, vk: 0x13 },
};

for (let digit = 0; digit <= 9; digit++) {
  KEY_MAPPINGS[`Digit${digit}`] = { sc: digit === 0 ? 0x0b : digit + 1, vk: 0x30 + digit };
  KEY_MAPPINGS[`Numpad${digit}`] = {
    sc: [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49][digit]!,
    vk: 0x60 + digit,
  };
}

for (let number = 1; number <= 24; number++) {
  KEY_MAPPINGS[`F${number}`] = {
    sc: number <= 10 ? 0x3a + number
      : number <= 12 ? 0x57 + number - 11
        : number <= 23 ? 0x64 + number - 13 : 0x76,
    vk: 0x6f + number,
  };
}

interface HeldKey {
  mapping: KeyMapping;
  vk: number;
  characters: number[];
}

export function encodeWin32Key(
  vk: number,
  sc: number,
  uc: number,
  down: boolean,
  controlState: number,
  repeat = 1,
): string {
  return `\x1b[${vk};${sc};${uc};${down ? 1 : 0};${controlState};${repeat}_`;
}

function characterCodes(event: KeyEventLike, controlState: number): number[] {
  switch (event.key) {
    case 'Enter': return [13];
    case 'Tab': return [9];
    case 'Backspace': return [8];
    case 'Escape': return [27];
  }

  if ([...event.key].length !== 1) {
    return [0];
  }

  // Right Alt + Ctrl is Windows AltGr. Never turn its printable output into
  // a control character (including '@', whose Ctrl equivalent would be NUL).
  const ctrl = (controlState & (LEFT_CTRL | RIGHT_CTRL)) !== 0;
  const altGr = event.getModifierState('AltGraph')
    || (ctrl && (controlState & RIGHT_ALT) !== 0);
  if (ctrl && !altGr) {
    const character = event.key.toUpperCase();
    if (/^[A-Z@[\]\\^_]$/.test(character) || character === ' ') {
      return [character.charCodeAt(0) & 0x1f];
    }
  }

  // KEY_EVENT_RECORD contains one UTF-16 code unit, not a Unicode code point.
  return event.key.split('').map((character) => character.charCodeAt(0));
}

export class Win32InputEncoder {
  private readonly held = new Map<string, HeldKey>();
  private lockState = 0;

  /** Returns null when xterm should handle composition, dead keys, or unknown input. */
  encode(event: KeyEventLike): string | null {
    if (event.type === 'keypress' || event.isComposing || event.keyCode === 229
      || event.key === 'Process' || event.key === 'Dead' || event.key === 'Unidentified') {
      return null;
    }
    if (!Object.hasOwn(KEY_MAPPINGS, event.code)) {
      return null;
    }

    const mapping = KEY_MAPPINGS[event.code]!;
    const down = event.type === 'keydown';
    // Reconcile on ordinary keys only: that is where a stuck modifier does damage, and
    // their DOM modifier flags are always accurate (modifier events can lag on AltGr).
    const released = mapping.modifier === undefined ? this.releaseStaleModifiers(event) : '';
    const previous = this.held.get(event.code);
    if (!down && !previous && mapping.modifier === undefined) {
      return released || null;
    }

    const vk = previous?.vk ?? (event.keyCode > 0 ? event.keyCode : mapping.vk);
    if (down) {
      this.held.set(event.code, { mapping, vk, characters: [0] });
    } else {
      this.held.delete(event.code);
    }

    this.lockState = (event.getModifierState('CapsLock') ? CAPSLOCK : 0)
      | (event.getModifierState('NumLock') ? NUMLOCK : 0)
      | (event.getModifierState('ScrollLock') ? SCROLLLOCK : 0);
    let state = this.heldModifiers();
    // If focus began with a modifier already held, DOM flags still let us encode
    // shortcuts. Once its own events arrive, prefer their left/right identity.
    if (event.ctrlKey && !(state & (LEFT_CTRL | RIGHT_CTRL))
      && !(event.type === 'keyup' && mapping.modifier !== undefined
        && (mapping.modifier & (LEFT_CTRL | RIGHT_CTRL)))) {
      state |= LEFT_CTRL;
    }
    if (event.altKey && !(state & (LEFT_ALT | RIGHT_ALT))
      && !(event.type === 'keyup' && mapping.modifier !== undefined
        && (mapping.modifier & (LEFT_ALT | RIGHT_ALT)))) {
      state |= event.getModifierState('AltGraph') ? RIGHT_ALT : LEFT_ALT;
    }
    if (event.shiftKey && !(event.type === 'keyup' && mapping.modifier === SHIFT)) {
      state |= SHIFT;
    }
    if (event.getModifierState('AltGraph')) {
      state |= LEFT_CTRL | RIGHT_ALT;
    }
    state |= this.lockState | (mapping.enhanced ? ENHANCED_KEY : 0);

    const characters = characterCodes(event, state);
    if (down) {
      this.held.set(event.code, { mapping, vk, characters });
    }
    // Autorepeat is another keydown with Rc=1, just as in Windows Terminal.
    return released + characters.map((uc) => encodeWin32Key(vk, mapping.sc, uc, down, state)).join('');
  }

  /**
   * A modifier whose key-up went elsewhere (focus moved to a dialog or the palette,
   * Win+L, Alt+Tab) would otherwise stay "held" and turn every later key into
   * Ctrl/Alt/Shift+key. Each DOM event's modifier flags are authoritative: release
   * whatever they say is no longer down, and tell the shell with a key-up record.
   */
  private releaseStaleModifiers(event: KeyEventLike): string {
    const altGraph = event.getModifierState('AltGraph');
    let result = '';
    for (const [code, held] of [...this.held.entries()]) {
      const bits = held.mapping.modifier;
      if (!bits || code === event.code) {
        continue;
      }
      const stillDown = bits & (LEFT_CTRL | RIGHT_CTRL)
        ? event.ctrlKey || altGraph
        : bits & (LEFT_ALT | RIGHT_ALT)
          ? event.altKey || altGraph
          : event.shiftKey;
      if (stillDown) {
        continue;
      }
      this.held.delete(code);
      const state = this.heldModifiers() | this.lockState | (held.mapping.enhanced ? ENHANCED_KEY : 0);
      result += encodeWin32Key(held.vk, held.mapping.sc, 0, false, state);
    }
    return result;
  }

  /** Release ordinary keys before modifiers, then forget all state on blur. */
  releaseAll(): string {
    const keys = [...this.held.entries()];
    keys.sort(([, a], [, b]) => Number(a.mapping.modifier !== undefined)
      - Number(b.mapping.modifier !== undefined));
    let result = '';
    for (const [code, { mapping, vk, characters }] of keys) {
      this.held.delete(code);
      const state = this.heldModifiers() | this.lockState | (mapping.enhanced ? ENHANCED_KEY : 0);
      result += characters.map((uc) => encodeWin32Key(vk, mapping.sc, uc, false, state)).join('');
    }
    this.lockState = 0;
    return result;
  }

  private heldModifiers(): number {
    let state = 0;
    for (const { mapping } of this.held.values()) {
      state |= mapping.modifier ?? 0;
    }
    return state;
  }
}
