// Viewport placement for menus, submenus and tooltips.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const VIEWPORT_MARGIN = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** Menu at a point: opens right/down, flips left/up when it would overflow, then clamps. */
export function placeMenu(at: Point, size: Size, viewport: Size, margin = VIEWPORT_MARGIN): Point {
  let x = at.x;
  let y = at.y;
  if (x + size.width > viewport.width - margin) {
    x = at.x - size.width;
  }
  if (y + size.height > viewport.height - margin) {
    y = at.y - size.height;
  }
  return {
    x: clamp(x, margin, viewport.width - size.width - margin),
    y: clamp(y, margin, viewport.height - size.height - margin),
  };
}

/** Submenu beside its parent panel, aligned with the row that opened it. */
export function placeSubmenu(panel: RectLike, row: RectLike, size: Size, viewport: Size, margin = VIEWPORT_MARGIN, inset = 4): Point {
  let x = panel.right - 2;
  if (x + size.width > viewport.width - margin) {
    x = panel.left - size.width + 2;
  }
  return {
    x: clamp(x, margin, viewport.width - size.width - margin),
    y: clamp(row.top - inset, margin, viewport.height - size.height - margin),
  };
}

/** Tooltip offset from the pointer; jumps to the other side of the pointer near edges. */
export function placeTooltip(at: Point, size: Size, viewport: Size, offset = 14, margin = VIEWPORT_MARGIN): Point {
  let x = at.x + offset;
  let y = at.y + offset;
  if (x + size.width > viewport.width - margin) {
    x = at.x - offset - size.width;
  }
  if (y + size.height > viewport.height - margin) {
    y = at.y - offset - size.height;
  }
  return {
    x: clamp(x, margin, viewport.width - size.width - margin),
    y: clamp(y, margin, viewport.height - size.height - margin),
  };
}
