import { describe, expect, it } from 'vitest';

import { nearEdge, snapFraction, zoneFor } from './drop-zones';

describe('zoneFor', () => {
  it('docks on the nearest edge within the band, swaps in the middle', () => {
    expect(zoneFor(0.1, 0.5)).toBe('left');
    expect(zoneFor(0.9, 0.5)).toBe('right');
    expect(zoneFor(0.5, 0.05)).toBe('up');
    expect(zoneFor(0.5, 0.95)).toBe('down');
    expect(zoneFor(0.5, 0.5)).toBe('center');
    expect(zoneFor(0.35, 0.6)).toBe('center');
  });

  it('prefers the closer edge near corners', () => {
    expect(zoneFor(0.05, 0.2)).toBe('left');
    expect(zoneFor(0.2, 0.05)).toBe('up');
  });
});

describe('nearEdge', () => {
  it('reveals an anchor only close to an edge', () => {
    expect(nearEdge(10, 200, 800, 400)).toBe('left');
    expect(nearEdge(790, 200, 800, 400)).toBe('right');
    expect(nearEdge(400, 6, 800, 400)).toBe('up');
    expect(nearEdge(400, 395, 800, 400)).toBe('down');
    expect(nearEdge(400, 200, 800, 400)).toBeNull();
  });

  it('covers the spot where each anchor is drawn, so hovering it reveals it', () => {
    // Anchor centres: left 18 px, right 32 px (clear of the scrollbar), up/down 17 px in.
    expect(nearEdge(18, 200, 800, 400)).toBe('left');
    expect(nearEdge(800 - 32, 200, 800, 400)).toBe('right');
    expect(nearEdge(800 - 44, 200, 800, 400)).toBe('right');
    expect(nearEdge(400, 17, 800, 400)).toBe('up');
    expect(nearEdge(400, 400 - 29, 800, 400)).toBe('down');
  });

  it('picks the relatively closer edge in a corner', () => {
    expect(nearEdge(3, 20, 800, 400)).toBe('left');
    expect(nearEdge(25, 2, 800, 400)).toBe('up');
  });
});

describe('snapFraction', () => {
  it('snaps near halves and thirds only', () => {
    expect(snapFraction(0.51)).toBe(0.5);
    expect(snapFraction(0.34)).toBeCloseTo(1 / 3);
    expect(snapFraction(0.655)).toBeCloseTo(2 / 3);
    expect(snapFraction(0.42)).toBe(0.42);
  });
});
