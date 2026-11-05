import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { dismissToast, getState, type Toast } from '../../state/store';
import { cx } from './cx';

const MAX_VISIBLE = 4;
/** After the pointer leaves a toast whose timer already expired. */
const HOLD_GRACE_MS = 1500;

/**
 * pushToast owns the auto-dismiss timer, so hovering can't pause it. Instead a
 * toast that expires while hovered is held locally (at its old position) until
 * the pointer leaves, then dismissed after a short grace period.
 */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  const [held, setHeld] = useState<{ toast: Toast; index: number } | null>(null);
  const graceTimer = useRef<number | null>(null);

  const visible = useMemo(() => {
    if (!held || toasts.some((toast) => toast.id === held.toast.id)) {
      return toasts.slice(-MAX_VISIBLE);
    }
    const list = [...toasts];
    list.splice(Math.min(held.index, list.length), 0, held.toast);
    return list.slice(-MAX_VISIBLE);
  }, [toasts, held]);

  useEffect(
    () => () => {
      if (graceTimer.current !== null) {
        window.clearTimeout(graceTimer.current);
      }
    },
    [],
  );

  const clearGrace = () => {
    if (graceTimer.current !== null) {
      window.clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
  };

  const enter = (toast: Toast, index: number) => {
    clearGrace();
    setHeld({ toast, index });
  };

  const leave = () => {
    clearGrace();
    const expired = held && !getState().ui.toasts.some((toast) => toast.id === held.toast.id);
    if (expired) {
      graceTimer.current = window.setTimeout(() => setHeld(null), HOLD_GRACE_MS);
    } else {
      setHeld(null);
    }
  };

  const close = (id: string) => {
    if (held?.toast.id === id) {
      clearGrace();
      setHeld(null);
    }
    dismissToast(id);
  };

  if (!visible.length) {
    return null;
  }

  return (
    <div className="ov-toasts">
      {visible.map((toast, index) => (
        <div
          key={toast.id}
          className={cx('ov-toast', `ov-toast--${toast.tone}`)}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          onMouseEnter={() => enter(toast, index)}
          onMouseLeave={leave}
        >
          <div className="ov-toast__content">
            <div className="ov-toast__title">{toast.title}</div>
            {toast.body && <div className="ov-toast__body">{toast.body}</div>}
            {toast.action && (
              <button
                type="button"
                className="btn btn--sm ov-toast__action"
                onClick={() => {
                  toast.action?.run();
                  close(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button type="button" className="icon-btn icon-btn--sm ov-toast__close" aria-label="Dismiss" onClick={() => close(toast.id)}>
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>
      ))}
    </div>
  );
}
