// N-ary split layout tree. All operations are pure and return new trees.

import type { LayoutNode, PaneNode, SplitDirection, SplitNode } from './session';

export type Edge = 'left' | 'right' | 'up' | 'down';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_PANE_FRACTION = 0.05;

export function paneLeaf(paneId: string): PaneNode {
  return { type: 'pane', paneId };
}

export function listPaneIds(node: LayoutNode): string[] {
  if (node.type === 'pane') {
    return [node.paneId];
  }

  return node.children.flatMap(listPaneIds);
}

export function containsPane(node: LayoutNode, paneId: string): boolean {
  if (node.type === 'pane') {
    return node.paneId === paneId;
  }

  return node.children.some((child) => containsPane(child, paneId));
}

/** A balanced grid with `columns` x `rows` cells (n-ary, so every column has equal width). */
export function buildGrid(paneIds: string[], columns: number): LayoutNode {
  if (paneIds.length === 1) {
    return paneLeaf(paneIds[0]);
  }

  const safeColumns = Math.max(1, Math.min(columns, paneIds.length));
  const rowCount = Math.ceil(paneIds.length / safeColumns);
  const rows: LayoutNode[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const ids = paneIds.slice(rowIndex * safeColumns, rowIndex * safeColumns + safeColumns);
    rows.push(ids.length === 1 ? paneLeaf(ids[0]) : split('row', ids.map(paneLeaf)));
  }

  return rows.length === 1 ? rows[0] : split('column', rows);
}

function split(direction: SplitDirection, children: LayoutNode[], sizes?: number[]): SplitNode {
  return {
    type: 'split',
    direction,
    children,
    sizes: sizes && sizes.length === children.length ? normalizeSizes(sizes) : children.map(() => 1 / children.length),
  };
}

export function normalizeSizes(sizes: number[]): number[] {
  const clean = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));
  const total = clean.reduce((sum, size) => sum + size, 0);
  if (total <= 0) {
    return sizes.map(() => 1 / sizes.length);
  }

  return clean.map((size) => size / total);
}

function edgeDirection(edge: Edge): SplitDirection {
  return edge === 'left' || edge === 'right' ? 'row' : 'column';
}

function edgeIsAfter(edge: Edge): boolean {
  return edge === 'right' || edge === 'down';
}

/**
 * Inserts `newPaneId` next to `targetPaneId`. When the target's parent split
 * already runs in the requested direction the new pane becomes a sibling (so
 * repeated "split right" yields equal columns instead of nested halves).
 */
export function splitPane(tree: LayoutNode, targetPaneId: string, newPaneId: string, edge: Edge, fraction = 0.5): LayoutNode {
  const direction = edgeDirection(edge);
  const after = edgeIsAfter(edge);
  const newFraction = Math.min(0.9, Math.max(0.1, fraction));

  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') {
      if (node.paneId !== targetPaneId) {
        return node;
      }

      const children = after ? [node, paneLeaf(newPaneId)] : [paneLeaf(newPaneId), node];
      const sizes = after ? [1 - newFraction, newFraction] : [newFraction, 1 - newFraction];
      return split(direction, children, sizes);
    }

    const directIndex = node.children.findIndex((child) => child.type === 'pane' && child.paneId === targetPaneId);
    if (directIndex >= 0 && node.direction === direction) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      const targetSize = sizes[directIndex];
      const insertedSize = targetSize * newFraction;
      sizes[directIndex] = targetSize - insertedSize;
      const insertAt = after ? directIndex + 1 : directIndex;
      children.splice(insertAt, 0, paneLeaf(newPaneId));
      sizes.splice(insertAt, 0, insertedSize);
      return { ...node, children, sizes: normalizeSizes(sizes) };
    }

    return { ...node, children: node.children.map(visit) };
  };

  return visit(tree);
}

/** Removes a pane; returns null when the tree becomes empty. */
export function removePane(tree: LayoutNode, paneId: string): LayoutNode | null {
  if (tree.type === 'pane') {
    return tree.paneId === paneId ? null : tree;
  }

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  tree.children.forEach((child, index) => {
    const next = removePane(child, paneId);
    if (next) {
      children.push(next);
      sizes.push(tree.sizes[index] ?? 0);
    }
  });

  if (!children.length) {
    return null;
  }

  if (children.length === 1) {
    return children[0];
  }

  return flatten({ ...tree, children, sizes: normalizeSizes(sizes) });
}

/** Merges nested splits that run in the same direction as their parent. */
export function flatten(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') {
    return node;
  }

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((rawChild, index) => {
    const child = flatten(rawChild);
    const size = node.sizes[index] ?? 1 / node.children.length;
    if (child.type === 'split' && child.direction === node.direction) {
      child.children.forEach((grandChild, grandIndex) => {
        children.push(grandChild);
        sizes.push(size * (child.sizes[grandIndex] ?? 1 / child.children.length));
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });

  if (children.length === 1) {
    return children[0];
  }

  return { ...node, children, sizes: normalizeSizes(sizes) };
}

export function equalize(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') {
    return node;
  }

  return { ...node, children: node.children.map(equalize), sizes: node.children.map(() => 1 / node.children.length) };
}

/** Replaces the sizes of the split found at `path` (child indexes from the root). */
export function setSizesAtPath(tree: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (tree.type === 'pane') {
    return tree;
  }

  if (!path.length) {
    const clamped = clampSizes(sizes);
    return clamped.length === tree.children.length ? { ...tree, sizes: clamped } : tree;
  }

  const [head, ...rest] = path;
  return {
    ...tree,
    children: tree.children.map((child, index) => (index === head ? setSizesAtPath(child, rest, sizes) : child)),
  };
}

function clampSizes(sizes: number[]): number[] {
  const normalized = normalizeSizes(sizes);
  if (normalized.every((size) => size >= MIN_PANE_FRACTION)) {
    return normalized;
  }

  return normalizeSizes(normalized.map((size) => Math.max(size, MIN_PANE_FRACTION)));
}

/**
 * Grows/shrinks the pane towards `edge` by `delta` (fraction of the parent).
 * Walks up to the nearest split in the matching orientation where the pane
 * has a neighbour on that side.
 */
export function resizePane(tree: LayoutNode, paneId: string, edge: Edge, delta = 0.05): LayoutNode {
  const direction = edgeDirection(edge);
  const towardsEnd = edgeIsAfter(edge);

  const visit = (node: LayoutNode): { node: LayoutNode; handled: boolean } => {
    if (node.type === 'pane') {
      return { node, handled: false };
    }

    const childIndex = node.children.findIndex((child) => containsPane(child, paneId));
    if (childIndex < 0) {
      return { node, handled: false };
    }

    const inner = visit(node.children[childIndex]);
    if (inner.handled) {
      const children = [...node.children];
      children[childIndex] = inner.node;
      return { node: { ...node, children }, handled: true };
    }

    if (node.direction !== direction) {
      return { node, handled: false };
    }

    const neighbourIndex = towardsEnd ? childIndex + 1 : childIndex - 1;
    if (neighbourIndex < 0 || neighbourIndex >= node.children.length) {
      return { node, handled: false };
    }

    const sizes = [...node.sizes];
    const available = sizes[neighbourIndex] - MIN_PANE_FRACTION;
    const applied = Math.max(-(sizes[childIndex] - MIN_PANE_FRACTION), Math.min(delta, available));
    sizes[childIndex] += applied;
    sizes[neighbourIndex] -= applied;
    return { node: { ...node, sizes: normalizeSizes(sizes) }, handled: true };
  };

  return visit(tree).node;
}

export function swapPanes(tree: LayoutNode, firstPaneId: string, secondPaneId: string): LayoutNode {
  if (tree.type === 'pane') {
    if (tree.paneId === firstPaneId) {
      return paneLeaf(secondPaneId);
    }
    if (tree.paneId === secondPaneId) {
      return paneLeaf(firstPaneId);
    }
    return tree;
  }

  return { ...tree, children: tree.children.map((child) => swapPanes(child, firstPaneId, secondPaneId)) };
}

/** Moves a pane next to another pane (drag & drop). */
export function movePane(tree: LayoutNode, paneId: string, targetPaneId: string, edge: Edge): LayoutNode {
  if (paneId === targetPaneId) {
    return tree;
  }

  const without = removePane(tree, paneId);
  if (!without || !containsPane(without, targetPaneId)) {
    return tree;
  }

  return splitPane(without, targetPaneId, paneId, edge);
}

/** Normalized rectangles (0..1) for every pane. */
export function computeRects(tree: LayoutNode, rect: Rect = { x: 0, y: 0, width: 1, height: 1 }): Map<string, Rect> {
  const rects = new Map<string, Rect>();

  const visit = (node: LayoutNode, area: Rect) => {
    if (node.type === 'pane') {
      rects.set(node.paneId, area);
      return;
    }

    let offset = 0;
    node.children.forEach((child, index) => {
      const size = node.sizes[index] ?? 1 / node.children.length;
      const childRect =
        node.direction === 'row'
          ? { x: area.x + area.width * offset, y: area.y, width: area.width * size, height: area.height }
          : { x: area.x, y: area.y + area.height * offset, width: area.width, height: area.height * size };
      offset += size;
      visit(child, childRect);
    });
  };

  visit(tree, rect);
  return rects;
}

/** The pane spatially adjacent to `paneId` in `edge` direction, if any. */
export function findNeighbour(tree: LayoutNode, paneId: string, edge: Edge): string | null {
  const rects = computeRects(tree);
  const origin = rects.get(paneId);
  if (!origin) {
    return null;
  }

  const epsilon = 1e-6;
  let best: { id: string; distance: number; overlap: number } | null = null;

  for (const [candidateId, candidate] of rects) {
    if (candidateId === paneId) {
      continue;
    }

    let distance: number;
    let overlap: number;
    if (edge === 'left' || edge === 'right') {
      distance = edge === 'right' ? candidate.x - (origin.x + origin.width) : origin.x - (candidate.x + candidate.width);
      overlap = Math.min(origin.y + origin.height, candidate.y + candidate.height) - Math.max(origin.y, candidate.y);
    } else {
      distance = edge === 'down' ? candidate.y - (origin.y + origin.height) : origin.y - (candidate.y + candidate.height);
      overlap = Math.min(origin.x + origin.width, candidate.x + candidate.width) - Math.max(origin.x, candidate.x);
    }

    if (distance < -epsilon || overlap <= epsilon) {
      continue;
    }

    if (!best || distance < best.distance - epsilon || (Math.abs(distance - best.distance) <= epsilon && overlap > best.overlap)) {
      best = { id: candidateId, distance, overlap };
    }
  }

  return best?.id ?? null;
}

/** Chooses the split edge for "auto" splits based on the pane's pixel aspect ratio. */
export function autoSplitEdge(widthPx: number, heightPx: number): Edge {
  return widthPx >= heightPx * 1.6 ? 'right' : 'down';
}

/** Validates an untrusted tree against known pane ids; returns null if unusable. */
export function sanitizeLayout(input: unknown, validPaneIds: Set<string>): LayoutNode | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<LayoutNode> & { children?: unknown[]; sizes?: unknown[] };
  if (candidate.type === 'pane') {
    return typeof candidate.paneId === 'string' && validPaneIds.has(candidate.paneId) ? paneLeaf(candidate.paneId) : null;
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children)) {
    const direction: SplitDirection = candidate.direction === 'column' ? 'column' : 'row';
    const rawSizes = Array.isArray(candidate.sizes) ? candidate.sizes : [];
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    candidate.children.forEach((child, index) => {
      const sanitized = sanitizeLayout(child, validPaneIds);
      if (sanitized) {
        children.push(sanitized);
        const size = rawSizes[index];
        sizes.push(typeof size === 'number' ? size : 0);
      }
    });

    if (!children.length) {
      return null;
    }

    if (children.length === 1) {
      return children[0];
    }

    return flatten({ type: 'split', direction, children, sizes: normalizeSizes(sizes.some((size) => size > 0) ? sizes : children.map(() => 1)) });
  }

  return null;
}
