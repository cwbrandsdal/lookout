import { Fragment, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import { listPaneIds } from '../shared/layout';
import type { LayoutNode, SplitNode } from '../shared/session';
import { setSplitSizes } from '../state/actions';
import { patchUi, useApp, type TabRuntime } from '../state/store';
import { snapFraction } from './drop-zones';
import { PaneView } from './PaneView';

export function PaneGrid({ tab }: { tab: TabRuntime }) {
  const paneHeaders = useApp((state) => state.settings.window.paneHeaders);
  const multi = Object.keys(tab.panes).length > 1;
  const showHeaders = paneHeaders === 'always' || (paneHeaders === 'auto' && multi && !tab.zoomedPaneId);

  if (tab.zoomedPaneId && tab.panes[tab.zoomedPaneId]) {
    return (
      <div className="grid">
        <PaneView focused multi={false} paneId={tab.zoomedPaneId} showHeader={paneHeaders === 'always'} tab={tab} />
      </div>
    );
  }

  return (
    <div className={`grid ${multi ? 'grid--multi' : ''} ${tab.broadcast ? 'grid--broadcast' : ''}`}>
      <LayoutView node={tab.layout} path={[]} showHeaders={showHeaders} tab={tab} />
    </div>
  );
}

function nodeKey(node: LayoutNode): string {
  return node.type === 'pane' ? node.paneId : `split:${listPaneIds(node)[0]}`;
}

function LayoutView({ node, path, tab, showHeaders }: { node: LayoutNode; path: number[]; tab: TabRuntime; showHeaders: boolean }) {
  if (node.type === 'pane') {
    return (
      <PaneView
        focused={tab.focusedPaneId === node.paneId}
        multi={Object.keys(tab.panes).length > 1}
        paneId={node.paneId}
        showHeader={showHeaders}
        tab={tab}
      />
    );
  }

  return (
    <div className={`split split--${node.direction}`}>
      {node.children.map((child, index) => (
        <Fragment key={nodeKey(child)}>
          <div className="split__cell" style={{ flexGrow: node.sizes[index] ?? 1, flexBasis: 0 }}>
            <LayoutView node={child} path={[...path, index]} showHeaders={showHeaders} tab={tab} />
          </div>
          {index < node.children.length - 1 ? <Divider index={index} node={node} path={path} tabId={tab.id} /> : null}
        </Fragment>
      ))}
    </div>
  );
}

function Divider({ node, path, index, tabId }: { node: SplitNode; path: number[]; index: number; tabId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = ref.current?.parentElement;
    if (!container || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.classList.add('is-dragging');

    const horizontal = node.direction === 'row';
    const rect = container.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const start = horizontal ? event.clientX : event.clientY;
    const initial = [...node.sizes];
    const pair = initial[index] + initial[index + 1];
    const minFraction = Math.min(pair / 2, 48 / Math.max(total, 1));
    let frame = 0;
    patchUi({ resizingTabId: tabId });

    const move = (moveEvent: PointerEvent) => {
      const delta = ((horizontal ? moveEvent.clientX : moveEvent.clientY) - start) / Math.max(total, 1);
      let first = Math.min(pair - minFraction, Math.max(minFraction, initial[index] + delta));
      // Magnetic ½ ⅓ ⅔ (of the two panes being resized); hold Alt for free resizing.
      if (!moveEvent.altKey) {
        first = snapFraction(first / pair) * pair;
      }
      const sizes = [...initial];
      sizes[index] = first;
      sizes[index + 1] = pair - first;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSplitSizes(tabId, path, sizes));
    };
    const up = () => {
      patchUi({ resizingTabId: null });
      target.classList.remove('is-dragging');
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <div
      className={`divider divider--${node.direction}`}
      onDoubleClick={() => {
        const sizes = [...node.sizes];
        const pair = sizes[index] + sizes[index + 1];
        sizes[index] = pair / 2;
        sizes[index + 1] = pair / 2;
        setSplitSizes(tabId, path, sizes);
      }}
      onPointerDown={onPointerDown}
      ref={ref}
      title="Drag to resize (snaps to ½ ⅓ ⅔, hold Alt to resize freely) · double-click to even out"
    />
  );
}
