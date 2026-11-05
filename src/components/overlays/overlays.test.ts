import { describe, expect, it } from 'vitest';

import { applyInput, parsePalette, serializePalette } from './palette-model';
import { describePaste, formatBytes, joinLines, splitLines, visualizeControls } from './paste-format';
import { placeMenu, placeSubmenu, placeTooltip } from './position';
import { rankSections } from './rank';

const viewport = { width: 800, height: 600 };

describe('placeMenu', () => {
  it('opens at the point when it fits', () => {
    expect(placeMenu({ x: 100, y: 100 }, { width: 200, height: 300 }, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('flips left and up near the right and bottom edges', () => {
    expect(placeMenu({ x: 700, y: 500 }, { width: 200, height: 300 }, viewport)).toEqual({ x: 500, y: 200 });
  });

  it('clamps when flipping is not enough', () => {
    expect(placeMenu({ x: 100, y: 200 }, { width: 200, height: 590 }, viewport)).toEqual({ x: 100, y: 4 });
  });
});

describe('placeSubmenu', () => {
  const panel = { left: 100, top: 100, right: 300, bottom: 400 };
  const row = { left: 104, top: 150, right: 296, bottom: 176 };

  it('opens to the right of the parent, aligned with the row', () => {
    expect(placeSubmenu(panel, row, { width: 180, height: 200 }, viewport)).toEqual({ x: 298, y: 146 });
  });

  it('opens to the left when the right side has no room', () => {
    const wide = { left: 500, top: 100, right: 700, bottom: 400 };
    expect(placeSubmenu(wide, row, { width: 180, height: 200 }, viewport)).toEqual({ x: 322, y: 146 });
  });
});

describe('placeTooltip', () => {
  it('offsets from the pointer and jumps sides near edges', () => {
    expect(placeTooltip({ x: 10, y: 10 }, { width: 100, height: 20 }, viewport)).toEqual({ x: 24, y: 24 });
    expect(placeTooltip({ x: 790, y: 590 }, { width: 100, height: 20 }, viewport)).toEqual({ x: 676, y: 556 });
  });
});

describe('paste formatting', () => {
  it('splits lines and ignores trailing breaks', () => {
    expect(splitLines('a\r\nb\nc\r\n\r\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('')).toEqual(['']);
  });

  it('joins lines with spaces for "paste as one line"', () => {
    expect(joinLines('cd src\n  npm test  \n\nnpm run build\n')).toBe('cd src npm test npm run build');
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(48 * 1024)).toBe('48 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB');
  });

  it('describes why the paste needs confirmation', () => {
    expect(describePaste('a\nb\nc', 'multiline').title).toBe('Paste 3 lines?');
    expect(describePaste('x'.repeat(2048), 'large').title).toBe('Paste 2 KB?');
    expect(describePaste('a\nb', 'both').title).toBe('Paste 2 lines (3 B)?');
  });

  it('visualises control characters', () => {
    expect(visualizeControls('a\tb\x07\x7f')).toEqual([
      { text: 'a', kind: null },
      { text: '→   ', kind: 'tab' },
      { text: 'b', kind: null },
      { text: '␇', kind: 'control' },
      { text: '␡', kind: 'control' },
    ]);
  });
});

describe('palette scopes', () => {
  it('derives the scope from mode and prefix', () => {
    expect(parsePalette({ mode: 'commands', query: 'split' })).toEqual({ scope: 'commands', text: 'split' });
    expect(parsePalette({ mode: 'all', query: '#api' })).toEqual({ scope: 'workspaces', text: 'api' });
    expect(parsePalette({ mode: 'all', query: ':src' })).toEqual({ scope: 'directories', text: 'src' });
    expect(parsePalette({ mode: 'all', query: 'src' })).toEqual({ scope: 'all', text: 'src' });
  });

  it('round-trips through the store shape', () => {
    for (const scope of ['all', 'commands', 'profiles', 'tabs', 'workspaces', 'directories'] as const) {
      expect(parsePalette(serializePalette({ scope, text: 'x' }))).toEqual({ scope, text: 'x' });
    }
  });

  it('switches scope when a prefix is typed into an empty input', () => {
    expect(applyInput({ scope: 'all', text: '' }, '>')).toEqual({ scope: 'commands', text: '' });
    expect(applyInput({ scope: 'all', text: '' }, '@pw')).toEqual({ scope: 'profiles', text: 'pw' });
    expect(applyInput({ scope: 'commands', text: '' }, '#')).toEqual({ scope: 'workspaces', text: '' });
    expect(applyInput({ scope: 'all', text: 'a' }, 'a>')).toEqual({ scope: 'all', text: 'a>' });
  });
});

describe('rankSections', () => {
  const items = [
    { section: 'Tabs', label: 'api server' },
    { section: 'Tabs', label: 'docs' },
    { section: 'Commands', label: 'New tab' },
    { section: 'Commands', label: 'Close tab' },
    { section: 'Commands', label: 'Next tab' },
  ];

  it('keeps input order without a query', () => {
    const sections = rankSections(items, '');
    expect(sections.map((section) => section.title)).toEqual(['Tabs', 'Commands']);
    expect(sections[1].rows.map((row) => row.item.label)).toEqual(['New tab', 'Close tab', 'Next tab']);
  });

  it('orders sections by their best match and applies limits', () => {
    const sections = rankSections(items, 'tab', { defaultLimit: 2 });
    expect(sections.map((section) => section.title)).toEqual(['Commands']);
    expect(sections[0].rows).toHaveLength(2);
    expect(sections[0].rows[0].labelPositions).toEqual([4, 5, 6]);
  });

  it('caps the total', () => {
    const sections = rankSections(items, '', { maxTotal: 3 });
    expect(sections.flatMap((section) => section.rows)).toHaveLength(3);
  });
});
