// Pointer-driven pane rearranging: drag a pane by its header onto another
// pane (dock on an edge or swap in the center), onto a tab in the sidebar,
// onto the sidebar (new tab) or outside the window (new window). Esc cancels.

import type { PointerEvent as ReactPointerEvent } from 'react';

import { applyPaneDrop, tabOfPane } from '../state/actions';
import { patchUi, type PaneDropTarget } from '../state/store';
import { zoneFor } from './drop-zones';

const DRAG_THRESHOLD_PX = 5;

export function hitTest(paneId: string, clientX: number, clientY: number): PaneDropTarget | null {
  if (clientX < 0 || clientY < 0 || clientX >= window.innerWidth || clientY >= window.innerHeight) {
    return { kind: 'newWindow' };
  }

  const element = document.elementFromPoint(clientX, clientY);
  if (!element) {
    return null;
  }

  const paneElement = element.closest<HTMLElement>('[data-pane-id]');
  if (paneElement?.dataset.paneId) {
    const targetId = paneElement.dataset.paneId;
    if (targetId === paneId) {
      return null;
    }
    const rect = paneElement.getBoundingClientRect();
    return { kind: 'pane', paneId: targetId, zone: zoneFor((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height) };
  }

  const own = tabOfPane(paneId);
  const tabElement = element.closest<HTMLElement>('[data-tab-id]');
  if (tabElement?.dataset.tabId) {
    return own?.id === tabElement.dataset.tabId ? null : { kind: 'tab', tabId: tabElement.dataset.tabId };
  }

  if (element.closest('.sidebar')) {
    return own && Object.keys(own.panes).length > 1 ? { kind: 'newTab' } : null;
  }

  return null;
}

/** Starts tracking a potential drag from a pane header (pointerdown). */
export function beginPaneDrag(event: ReactPointerEvent<HTMLElement>, paneId: string): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, a')) {
    return;
  }

  const element = event.currentTarget;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let frame = 0;
  let last = { x: startX, y: startY };

  const publish = () => {
    frame = 0;
    patchUi({ paneDrag: { paneId, x: last.x, y: last.y, target: hitTest(paneId, last.x, last.y) } });
  };

  const onMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    last = { x: moveEvent.clientX, y: moveEvent.clientY };
    if (!dragging) {
      if (Math.hypot(last.x - startX, last.y - startY) < DRAG_THRESHOLD_PX) {
        return;
      }
      dragging = true;
      try {
        element.setPointerCapture(pointerId);
      } catch {
        // The pointer may already be gone.
      }
      document.documentElement.classList.add('is-pane-dragging');
    }
    if (!frame) {
      frame = requestAnimationFrame(publish);
    }
  };

  const finish = (upEvent: PointerEvent | null) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove('is-pane-dragging');
    try {
      element.releasePointerCapture(pointerId);
    } catch {
      // Not captured.
    }

    patchUi({ paneDrag: null });
    if (dragging && upEvent) {
      const target = hitTest(paneId, upEvent.clientX, upEvent.clientY);
      if (target) {
        applyPaneDrop(paneId, target, { x: upEvent.screenX, y: upEvent.screenY });
      }
    }
  };

  const onUp = (upEvent: PointerEvent) => {
    if (upEvent.pointerId === pointerId) {
      finish(upEvent);
    }
  };
  const onCancel = () => finish(null);
  const onKey = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === 'Escape' && dragging) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(null);
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}
