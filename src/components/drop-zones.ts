// Pure geometry for pane split anchors and drag & drop (no DOM, testable).

export type Zone = 'left' | 'right' | 'up' | 'down' | 'center';
export type EdgeZone = Exclude<Zone, 'center'>;

/** Fraction of a pane (from each edge) that counts as "dock on this edge". */
export const EDGE_BAND = 0.28;

/** Which zone of a pane a normalized point (0..1) is in. */
export function zoneFor(nx: number, ny: number, band = EDGE_BAND): Zone {
  const candidates: Array<[EdgeZone, number]> = [
    ['left', nx],
    ['right', 1 - nx],
    ['up', ny],
    ['down', 1 - ny],
  ];
  const [edge, distance] = candidates.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return distance < band ? edge : 'center';
}

/**
 * Which edge of a box a point is close to (pixels), for the split anchors.
 * The bands must cover the anchors themselves (left/right sit 6–44 px in, clear
 * of the scrollbar; up/down 5–29 px), so hovering an anchor's spot reveals it.
 */
export function nearEdge(x: number, y: number, width: number, height: number, bandX = 48, bandY = 36): EdgeZone | null {
  const candidates: Array<[EdgeZone, number, number]> = [
    ['left', x, bandX],
    ['right', width - x, bandX],
    ['up', y, bandY],
    ['down', height - y, bandY],
  ];
  let best: [EdgeZone, number] | null = null;
  for (const [edge, distance, band] of candidates) {
    if (distance >= 0 && distance < band && (!best || distance / band < best[1])) {
      best = [edge, distance / band];
    }
  }
  return best?.[0] ?? null;
}

/** Snaps a split fraction to ½, ⅓ or ⅔ when it is within `tolerance`. */
export function snapFraction(fraction: number, tolerance = 0.018): number {
  for (const point of [1 / 2, 1 / 3, 2 / 3]) {
    if (Math.abs(fraction - point) < tolerance) {
      return point;
    }
  }
  return fraction;
}
