import { memo } from 'react';

import { computeRects } from '../shared/layout';
import type { LayoutNode } from '../shared/session';

interface LayoutGlyphProps {
  layout: LayoutNode;
  focusedPaneId: string;
  active: boolean;
  /** Panes with unseen output or a bell. */
  attention: Set<string>;
  zoomedPaneId?: string | null;
  size?: { width: number; height: number };
}

/** A live miniature of a tab's split layout: the signature of each tab row. */
export const LayoutGlyph = memo(function LayoutGlyph({ layout, focusedPaneId, active, attention, zoomedPaneId, size = { width: 18, height: 14 } }: LayoutGlyphProps) {
  const rects = computeRects(layout);
  const gap = 1.25;

  return (
    <svg aria-hidden="true" className="layout-glyph" height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} width={size.width}>
      {[...rects.entries()].map(([paneId, rect]) => {
        const x = rect.x * size.width + gap / 2;
        const y = rect.y * size.height + gap / 2;
        const width = Math.max(1, rect.width * size.width - gap);
        const height = Math.max(1, rect.height * size.height - gap);
        const focused = paneId === focusedPaneId;
        const dimmed = Boolean(zoomedPaneId && zoomedPaneId !== paneId);
        const className = [
          'layout-glyph__cell',
          focused ? (active ? 'is-focused' : 'is-focused-muted') : '',
          attention.has(paneId) && !focused ? 'is-attention' : '',
          dimmed ? 'is-dimmed' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return <rect className={className} height={height} key={paneId} rx={1.25} width={width} x={x} y={y} />;
      })}
    </svg>
  );
});
