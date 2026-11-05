// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { Win32InputEncoder, encodeWin32Key } from './win32-input';
import type { KeyEventLike } from './win32-input';

function event(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    type: 'keydown',
    key: 'a',
    code: 'KeyA',
    keyCode: 65,
    location: 0,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...overrides,
  };
}

function modifier(code: string, type: KeyEventLike['type'] = 'keydown'): KeyEventLike {
  const key = code.replace(/Left|Right/, '');
  return event({
    code, key, type, keyCode: 0, location: code.endsWith('Right') ? 2 : 1,
    ctrlKey: key === 'Control' && type === 'keydown',
    altKey: key === 'Alt' && type === 'keydown',
    shiftKey: key === 'Shift' && type === 'keydown',
    metaKey: key === 'Meta' && type === 'keydown',
  });
}

describe('Win32InputEncoder', () => {
  it('formats all six fields and defaults repeat to one', () => {
    expect(encodeWin32Key(65, 30, 97, true, 0)).toBe('\x1b[65;30;97;1;0;1_');
    expect(encodeWin32Key(65, 30, 97, false, 8, 3)).toBe('\x1b[65;30;97;0;8;3_');
  });

  it('encodes plain letters and paired keyups', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event())).toBe('\x1b[65;30;97;1;0;1_');
    expect(encoder.encode(event({ type: 'keyup' }))).toBe('\x1b[65;30;97;0;0;1_');
    expect(encoder.releaseAll()).toBe('');
  });

  it('keeps the original VK on a paired keyup and repeat', () => {
    const encoder = new Win32InputEncoder();
    const key = { code: 'BracketLeft', key: 'å', keyCode: 221 };
    expect(encoder.encode(event(key))).toBe('\x1b[221;26;229;1;0;1_');
    expect(encoder.encode(event({ ...key, keyCode: 0, repeat: true })))
      .toBe('\x1b[221;26;229;1;0;1_');
    expect(encoder.encode(event({ ...key, keyCode: 0, type: 'keyup' })))
      .toBe('\x1b[221;26;229;0;0;1_');
  });

  it('releases a modifier whose key-up was missed, so later keys are not Ctrl+key', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(modifier('ControlLeft'))).toBe('\x1b[17;29;0;1;8;1_');
    // Ctrl+V opened the paste dialog, so Ctrl's key-up went to the dialog. Back in the
    // terminal the next key arrives without ctrlKey: release Ctrl first, then type a plain 'p'.
    expect(encoder.encode(event({ code: 'KeyP', key: 'p', keyCode: 80 }))).toBe('\x1b[17;29;0;0;0;1_\x1b[80;25;112;1;0;1_');
    expect(encoder.releaseAll()).toBe('\x1b[80;25;112;0;0;1_');
  });

  it('keeps Ctrl and Alt held while AltGr is down', () => {
    const encoder = new Win32InputEncoder();
    const altGraph = { getModifierState: (key: string) => key === 'AltGraph' };
    encoder.encode(modifier('ControlLeft'));
    encoder.encode(event({ ...modifier('AltRight'), ctrlKey: true, ...altGraph }));
    const at = encoder.encode(event({ code: 'Digit2', key: '@', keyCode: 50, ctrlKey: true, altKey: true, ...altGraph }));
    // Right Alt (1) + Left Ctrl (8), and no key-up records in front of it.
    expect(at).toBe('\x1b[50;3;64;1;9;1_');
  });

  it('encodes Shift itself and uses the character for the current modifier state', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(modifier('ShiftLeft'))).toBe('\x1b[16;42;0;1;16;1_');
    expect(encoder.encode(event({ key: 'A', shiftKey: true }))).toBe('\x1b[65;30;65;1;16;1_');
    expect(encoder.encode(modifier('ShiftLeft', 'keyup'))).toBe('\x1b[16;42;0;0;0;1_');
    expect(encoder.encode(event({ type: 'keyup' }))).toBe('\x1b[65;30;97;0;0;1_');
  });

  it.each(['a', 'A', 'z', 'Z'])('converts Ctrl+%s to a control character', (key) => {
    const upper = key.toUpperCase();
    const code = `Key${upper}`;
    const sc = upper === 'A' ? 30 : 44;
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(modifier('ControlLeft'))).toBe('\x1b[17;29;0;1;8;1_');
    expect(encoder.encode(event({ key, code, keyCode: upper.charCodeAt(0), ctrlKey: true })))
      .toBe(encodeWin32Key(upper.charCodeAt(0), sc, upper.charCodeAt(0) & 31, true, 8));
  });

  it.each([
    [' ', 'Space', 32, 57, 0, true, false],
    ['Backspace', 'Backspace', 8, 14, 8, true, false],
    ['Enter', 'Enter', 13, 28, 13, false, true],
    ['Enter', 'Enter', 13, 28, 13, true, false],
    ['Tab', 'Tab', 9, 15, 9, false, false],
    ['Escape', 'Escape', 27, 1, 27, false, false],
  ] as const)('encodes %s with Ctrl=%s Shift=%s', (key, code, keyCode, sc, uc, ctrlKey, shiftKey) => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event({ key, code, keyCode, ctrlKey, shiftKey })))
      .toBe(encodeWin32Key(keyCode, sc, uc, true, (ctrlKey ? 8 : 0) | (shiftKey ? 16 : 0)));
  });

  it('keeps repeat keydowns at Rc=1 and releases a repeated key only once', () => {
    const encoder = new Win32InputEncoder();
    encoder.encode(event());
    expect(encoder.encode(event({ repeat: true }))).toBe('\x1b[65;30;97;1;0;1_');
    expect(encoder.releaseAll()).toBe('\x1b[65;30;97;0;0;1_');
  });

  it.each([
    ['@', 'Digit2', 50, 3],
    ['{', 'Digit7', 55, 8],
    ['€', 'KeyE', 69, 18],
    ['£', 'Digit3', 51, 4],
    ['$', 'Digit4', 52, 5],
    ['[', 'Digit8', 56, 9],
    [']', 'Digit9', 57, 10],
    ['}', 'Digit0', 48, 11],
    ['\\', 'Minus', 219, 12],
    ['|', 'Backquote', 220, 41],
    ['~', 'BracketRight', 186, 27],
  ] as const)('preserves Norwegian AltGr %s', (key, code, keyCode, sc) => {
    const encoder = new Win32InputEncoder();
    encoder.encode(modifier('ControlLeft'));
    const altGr = (name: string) => name === 'AltGraph';
    expect(encoder.encode(event({
      ...modifier('AltRight'), ctrlKey: true, getModifierState: altGr,
    }))).toBe('\x1b[18;56;0;1;265;1_');
    const keyEvent = event({ key, code, keyCode, ctrlKey: true, altKey: true, getModifierState: altGr });
    expect(encoder.encode(keyEvent)).toBe(encodeWin32Key(keyCode, sc, key.charCodeAt(0), true, 9));
    expect(encoder.encode({ ...keyEvent, type: 'keyup' }))
      .toBe(encodeWin32Key(keyCode, sc, key.charCodeAt(0), false, 9));
    expect(encoder.encode(event({
      ...modifier('AltRight', 'keyup'), ctrlKey: true,
    }))).toBe('\x1b[18;56;0;0;264;1_');
    expect(encoder.encode(modifier('ControlLeft', 'keyup'))).toBe('\x1b[17;29;0;0;0;1_');
  });

  it('recognizes AltGraph when focus began with the modifiers held', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event({
      key: '@', code: 'Digit2', keyCode: 50, ctrlKey: true, altKey: true,
      getModifierState: (key) => key === 'AltGraph',
    }))).toBe('\x1b[50;3;64;1;9;1_');
  });

  it('distinguishes left and right Ctrl/Alt and excludes ENHANCED_KEY from other keys', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(modifier('ControlRight'))).toBe('\x1b[17;29;0;1;260;1_');
    expect(encoder.encode(modifier('ControlLeft'))).toBe('\x1b[17;29;0;1;12;1_');
    expect(encoder.encode(modifier('ControlRight', 'keyup'))).toBe('\x1b[17;29;0;0;264;1_');
    expect(encoder.encode(modifier('AltLeft'))).toBe('\x1b[18;56;0;1;10;1_');
    expect(encoder.encode(event({ key: 'F1', code: 'F1', keyCode: 112, ctrlKey: true, altKey: true })))
      .toBe('\x1b[112;59;0;1;10;1_');
  });

  it('keeps Shift active until both Shift keys are released', () => {
    const encoder = new Win32InputEncoder();
    encoder.encode(modifier('ShiftLeft'));
    expect(encoder.encode(modifier('ShiftRight'))).toBe('\x1b[16;54;0;1;16;1_');
    expect(encoder.encode(modifier('ShiftLeft', 'keyup'))).toBe('\x1b[16;42;0;0;16;1_');
    expect(encoder.encode(modifier('ShiftRight', 'keyup'))).toBe('\x1b[16;54;0;0;0;1_');
  });

  it('reads all lock state bits and preserves them on releaseAll', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event({ getModifierState: (key) => key.endsWith('Lock') })))
      .toBe('\x1b[65;30;97;1;224;1_');
    expect(encoder.releaseAll()).toBe('\x1b[65;30;97;0;224;1_');
    expect(encoder.encode(event())).toBe('\x1b[65;30;97;1;0;1_');
  });

  it('emits a UTF-16 record for each surrogate on both down and up', () => {
    const encoder = new Win32InputEncoder();
    const input = event({ key: '😀' });
    expect(encoder.encode(input)).toBe('\x1b[65;30;55357;1;0;1_\x1b[65;30;56832;1;0;1_');
    expect(encoder.encode({ ...input, type: 'keyup' }))
      .toBe('\x1b[65;30;55357;0;0;1_\x1b[65;30;56832;0;0;1_');
  });

  it.each([
    { key: 'Dead', code: 'BracketRight', keyCode: 186 }, // Norwegian dead ^ key.
    { isComposing: true },
    { keyCode: 229 },
    { key: 'Process' },
    { key: 'Unidentified' },
    { type: 'keypress' as const },
    { code: 'Unknown' },
    { code: '__proto__' },
  ])('leaves unsupported/composition input to xterm: %o', (overrides) => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event(overrides))).toBeNull();
    expect(encoder.releaseAll()).toBe('');
  });

  it('does not encode a dead/composition/unhandled keyup without its keydown', () => {
    const encoder = new Win32InputEncoder();
    encoder.encode(event({ key: 'Dead', code: 'BracketRight', keyCode: 186 }));
    expect(encoder.encode(event({ type: 'keyup', key: '^', code: 'BracketRight', keyCode: 186 })))
      .toBeNull();
    expect(encoder.encode(event({ type: 'keyup' }))).toBeNull();
    expect(encoder.encode(modifier('ControlRight', 'keyup'))).toBe('\x1b[17;29;0;0;256;1_');
  });

  it('releases ordinary keys first, clears modifier sides, and is idempotent on blur', () => {
    const encoder = new Win32InputEncoder();
    encoder.encode(modifier('ControlLeft'));
    encoder.encode(modifier('AltRight'));
    encoder.encode(event({ key: '@', code: 'Digit2', keyCode: 50, ctrlKey: true, altKey: true }));
    expect(encoder.releaseAll()).toBe(
      '\x1b[50;3;64;0;9;1_\x1b[17;29;0;0;1;1_\x1b[18;56;0;0;256;1_',
    );
    expect(encoder.releaseAll()).toBe('');
    expect(encoder.encode(event())).toBe('\x1b[65;30;97;1;0;1_');
  });
});

describe('physical scan codes and fallback VKs', () => {
  const letters = [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50,
    49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44];
  it.each(letters.map((sc, index) => [String.fromCharCode(65 + index), sc] as const))('maps Key%s', (key, sc) => {
      expect(new Win32InputEncoder().encode(event({ key, code: `Key${key}`, keyCode: 0 })))
        .toBe(encodeWin32Key(key.charCodeAt(0), sc, key.charCodeAt(0), true, 0));
    });

  it.each(Array.from({ length: 10 }, (_, digit) => digit))('maps Digit%s and Numpad%s', (digit) => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event({ key: String(digit), code: `Digit${digit}`, keyCode: 0 })))
      .toBe(encodeWin32Key(48 + digit, digit === 0 ? 11 : digit + 1, 48 + digit, true, 0));
    const sc = [82, 79, 80, 81, 75, 76, 77, 71, 72, 73][digit]!;
    expect(encoder.encode(event({ key: String(digit), code: `Numpad${digit}`, keyCode: 0, location: 3 })))
      .toBe(encodeWin32Key(96 + digit, sc, 48 + digit, true, 0));
  });

  it.each(Array.from({ length: 24 }, (_, index) => index + 1))('maps F%s', (number) => {
    const sc = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88,
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 118][number - 1]!;
    expect(new Win32InputEncoder().encode(event({ key: `F${number}`, code: `F${number}`, keyCode: 0 })))
      .toBe(encodeWin32Key(111 + number, sc, 0, true, 0));
  });

  it.each([
    ['Minus', 12, 189], ['Equal', 13, 187], ['BracketLeft', 26, 219], ['BracketRight', 27, 221],
    ['Semicolon', 39, 186], ['Quote', 40, 222], ['Backquote', 41, 192], ['Backslash', 43, 220],
    ['Comma', 51, 188], ['Period', 52, 190], ['Slash', 53, 191], ['IntlBackslash', 86, 226],
    ['IntlRo', 115, 226], ['IntlYen', 125, 220], ['NumpadEqual', 89, 146],
    ['NumpadMultiply', 55, 106], ['NumpadSubtract', 74, 109], ['NumpadAdd', 78, 107],
    ['NumpadDecimal', 83, 110], ['NumpadComma', 126, 108], ['Pause', 69, 19],
    ['CapsLock', 58, 20], ['ScrollLock', 70, 145],
  ] as const)('maps %s without ENHANCED_KEY', (code, sc, vk) => {
    expect(new Win32InputEncoder().encode(event({ key: code, code, keyCode: 0 })))
      .toBe(encodeWin32Key(vk, sc, 0, true, 0));
  });

  it.each([
    ['Insert', 82, 45], ['Delete', 83, 46], ['Home', 71, 36], ['End', 79, 35],
    ['PageUp', 73, 33], ['PageDown', 81, 34], ['ArrowUp', 72, 38], ['ArrowDown', 80, 40],
    ['ArrowLeft', 75, 37], ['ArrowRight', 77, 39], ['NumpadDivide', 53, 111],
    ['NumLock', 69, 144], ['PrintScreen', 55, 44], ['ContextMenu', 93, 93],
    ['MetaLeft', 91, 91], ['MetaRight', 92, 92],
  ] as const)('marks %s enhanced', (code, sc, vk) => {
    expect(new Win32InputEncoder().encode(event({ key: code, code, keyCode: 0 })))
      .toBe(encodeWin32Key(vk, sc, 0, true, 256));
  });

  it('distinguishes numpad Enter and numpad navigation from the navigation cluster', () => {
    const encoder = new Win32InputEncoder();
    expect(encoder.encode(event({ key: 'Enter', code: 'NumpadEnter', keyCode: 13, location: 3 })))
      .toBe('\x1b[13;28;13;1;256;1_');
    expect(encoder.encode(event({ key: 'End', code: 'Numpad1', keyCode: 35, location: 3 })))
      .toBe('\x1b[35;79;0;1;0;1_');
  });
});
