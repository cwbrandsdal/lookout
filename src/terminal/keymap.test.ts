import { describe, expect, it } from 'vitest';

import { isCommandId } from '../shared/commands';
import { chordForCommand, eventChord, formatChord, isAltGr, normalizeChord, resolveKeymap, type KeyLike } from './keymap';

function key(init: Partial<KeyLike> & { key: string; code: string }): KeyLike {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, getModifierState: () => false, ...init };
}

describe('normalizeChord', () => {
  it('canonicalises order, case and aliases', () => {
    expect(normalizeChord('Shift+Ctrl+T')).toBe('ctrl+shift+t');
    expect(normalizeChord('alt+shift+-')).toBe('alt+shift+minus');
    expect(normalizeChord('ctrl++')).toBe('ctrl+plus');
    expect(normalizeChord('ctrl+=')).toBe('ctrl+plus');
    expect(normalizeChord('win+`')).toBe('win+`');
    expect(normalizeChord('ctrl+comma')).toBe('ctrl+,');
  });
});

describe('eventChord', () => {
  it('uses physical digits so Shift+digit works on every layout', () => {
    expect(eventChord(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+1');
  });

  it('maps US and Norwegian plus/minus keys to plus/minus', () => {
    expect(eventChord(key({ key: '=', code: 'Equal', ctrlKey: true }))).toBe('ctrl+plus');
    expect(eventChord(key({ key: '+', code: 'Minus', ctrlKey: true }))).toBe('ctrl+plus');
    expect(eventChord(key({ key: '_', code: 'Minus', altKey: true, shiftKey: true }))).toBe('alt+shift+minus');
    expect(eventChord(key({ key: '-', code: 'Slash', ctrlKey: true }))).toBe('ctrl+minus');
  });

  it('ignores bare modifier presses', () => {
    expect(eventChord(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBe('');
  });

  it('maps navigation keys', () => {
    expect(eventChord(key({ key: 'PageUp', code: 'PageUp', shiftKey: true }))).toBe('shift+pageup');
    expect(eventChord(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }))).toBe('alt+left');
  });
});

describe('isAltGr', () => {
  it('detects AltGr characters so they always reach the shell', () => {
    expect(isAltGr(key({ key: '@', code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' }))).toBe(true);
    expect(isAltGr(key({ key: '{', code: 'Digit7', ctrlKey: true, altKey: true }))).toBe(true);
    expect(isAltGr(key({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe('resolveKeymap', () => {
  it('applies user overrides and unbinds', () => {
    const map = resolveKeymap(
      [
        { keys: 'ctrl+shift+t', command: null },
        { keys: 'ctrl+alt+t', command: 'newTab' },
        { keys: 'ctrl+q', command: 'not-a-command' },
      ],
      isCommandId,
    );
    expect(map.has('ctrl+shift+t')).toBe(false);
    expect(map.get('ctrl+alt+t')?.command).toBe('newTab');
    expect(map.has('ctrl+q')).toBe(false);
    expect(map.get('ctrl+c')?.command).toBe('copy');
  });

  it('never binds plain ctrl+letter defaults except copy/paste', () => {
    const map = resolveKeymap([], isCommandId);
    const plainCtrlLetters = [...map.keys()].filter((chord) => /^ctrl\+[a-z]$/.test(chord));
    expect(plainCtrlLetters.sort()).toEqual(['ctrl+c', 'ctrl+v']);
  });

  it('formats chords for display', () => {
    const map = resolveKeymap([], isCommandId);
    expect(formatChord(chordForCommand(map, 'commandPalette') ?? '')).toBe('Ctrl+Shift+P');
    expect(formatChord('alt+shift+minus')).toBe('Alt+Shift+-');
  });
});
