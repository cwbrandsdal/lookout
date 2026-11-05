import { describe, expect, it } from 'vitest';

import {
  buildGrid,
  computeRects,
  equalize,
  findNeighbour,
  flatten,
  listPaneIds,
  movePane,
  paneLeaf,
  removePane,
  resizePane,
  sanitizeLayout,
  setSizesAtPath,
  splitPane,
} from './layout';
import type { LayoutNode, SplitNode } from './session';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}`);

function widths(tree: LayoutNode): number[] {
  const rects = computeRects(tree);
  return listPaneIds(tree).map((id) => Math.round((rects.get(id)?.width ?? 0) * 1000) / 1000);
}

describe('buildGrid', () => {
  it('gives every column the same width (fixes the v1 25/25/50 bug)', () => {
    const grid = buildGrid(ids(6), 3);
    expect(widths(grid)).toEqual([0.333, 0.333, 0.333, 0.333, 0.333, 0.333]);
    const rects = computeRects(grid);
    expect(rects.get('p1')?.height).toBeCloseTo(0.5);
  });

  it('builds 5 and 7 column rows evenly and 3 even rows for 12 panes', () => {
    expect(new Set(widths(buildGrid(ids(10), 5)))).toEqual(new Set([0.2]));
    expect(new Set(widths(buildGrid(ids(14), 7)))).toEqual(new Set([0.143]));
    const twelve = computeRects(buildGrid(ids(12), 4));
    expect(twelve.get('p1')?.height).toBeCloseTo(1 / 3);
    expect(twelve.get('p12')?.height).toBeCloseTo(1 / 3);
  });

  it('returns a single pane leaf for one id', () => {
    expect(buildGrid(['a'], 3)).toEqual(paneLeaf('a'));
  });
});

describe('splitPane', () => {
  it('adds siblings instead of nesting when splitting in the same direction', () => {
    let tree: LayoutNode = paneLeaf('a');
    tree = splitPane(tree, 'a', 'b', 'right');
    tree = splitPane(tree, 'b', 'c', 'right');
    expect(tree.type).toBe('split');
    expect((tree as SplitNode).children).toHaveLength(3);
    expect(listPaneIds(tree)).toEqual(['a', 'b', 'c']);
  });

  it('nests when splitting across directions and respects before/after edges', () => {
    let tree: LayoutNode = splitPane(paneLeaf('a'), 'a', 'b', 'right');
    tree = splitPane(tree, 'b', 'c', 'down');
    tree = splitPane(tree, 'a', 'z', 'left');
    expect(listPaneIds(tree)).toEqual(['z', 'a', 'b', 'c']);
    const rects = computeRects(tree);
    expect(rects.get('c')!.y).toBeGreaterThan(rects.get('b')!.y);
  });
});

describe('removePane', () => {
  it('collapses single-child splits and renormalizes sizes', () => {
    let tree: LayoutNode = splitPane(paneLeaf('a'), 'a', 'b', 'right');
    tree = splitPane(tree, 'b', 'c', 'down');
    const removed = removePane(tree, 'c');
    expect(removed).not.toBeNull();
    expect(listPaneIds(removed!)).toEqual(['a', 'b']);
    expect((removed as SplitNode).sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
    expect(removePane(paneLeaf('a'), 'a')).toBeNull();
  });
});

describe('flatten', () => {
  it('merges nested splits with the same direction', () => {
    const nested: LayoutNode = {
      type: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [paneLeaf('a'), { type: 'split', direction: 'row', sizes: [0.5, 0.5], children: [paneLeaf('b'), paneLeaf('c')] }],
    };
    const flat = flatten(nested) as SplitNode;
    expect(flat.children).toHaveLength(3);
    expect(flat.sizes).toEqual([0.5, 0.25, 0.25]);
  });
});

describe('resizePane and setSizesAtPath', () => {
  it('moves the shared edge towards the requested side and clamps', () => {
    const tree = splitPane(paneLeaf('a'), 'a', 'b', 'right');
    const grown = resizePane(tree, 'a', 'right', 0.1) as SplitNode;
    expect(grown.sizes[0]).toBeCloseTo(0.6);
    const clamped = resizePane(tree, 'a', 'right', 5) as SplitNode;
    expect(clamped.sizes[1]).toBeGreaterThan(0.04);
    expect(resizePane(tree, 'a', 'up', 0.1)).toEqual(tree);
  });

  it('sets sizes by path and equalizes', () => {
    const tree = splitPane(splitPane(paneLeaf('a'), 'a', 'b', 'right'), 'b', 'c', 'down');
    const updated = setSizesAtPath(tree, [1], [0.8, 0.2]);
    const inner = (updated as SplitNode).children[1] as SplitNode;
    expect(inner.sizes[0]).toBeCloseTo(0.8);
    const even = equalize(updated) as SplitNode;
    expect(((even.children[1] as SplitNode).sizes[0])).toBeCloseTo(0.5);
  });
});

describe('findNeighbour and movePane', () => {
  const grid = buildGrid(['a', 'b', 'c', 'd'], 2);

  it('finds spatial neighbours in a 2x2 grid', () => {
    expect(findNeighbour(grid, 'a', 'right')).toBe('b');
    expect(findNeighbour(grid, 'a', 'down')).toBe('c');
    expect(findNeighbour(grid, 'd', 'up')).toBe('b');
    expect(findNeighbour(grid, 'a', 'left')).toBeNull();
  });

  it('moves a pane next to another', () => {
    const moved = movePane(grid, 'a', 'd', 'right');
    expect(listPaneIds(moved)).toContain('a');
    expect(findNeighbour(moved, 'd', 'right')).toBe('a');
  });
});

describe('sanitizeLayout', () => {
  it('drops unknown panes and repairs sizes', () => {
    const input = { type: 'split', direction: 'column', sizes: [1, 'x', 2], children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'ghost' }, { type: 'pane', paneId: 'b' }] };
    const result = sanitizeLayout(input, new Set(['a', 'b'])) as SplitNode;
    expect(listPaneIds(result)).toEqual(['a', 'b']);
    expect(result.sizes[0]).toBeCloseTo(1 / 3);
    expect(sanitizeLayout({ type: 'pane', paneId: 'ghost' }, new Set(['a']))).toBeNull();
  });
});
