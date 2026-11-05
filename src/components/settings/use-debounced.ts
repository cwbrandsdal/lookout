import { useCallback, useEffect, useRef } from 'react';

interface Pending<T> {
  value: T;
  commit: (value: T) => unknown;
}

/**
 * Debounces saves from a text-like control. `flush()` runs the pending save now and
 * resolves when it (or the save already in flight) has finished. Pending saves are
 * flushed on unmount, so closing settings never drops an edit.
 */
export function useDebouncedCommit<T>(delay = 300) {
  const pending = useRef<Pending<T> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const last = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback((): Promise<unknown> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const entry = pending.current;
    pending.current = null;
    if (entry) {
      last.current = Promise.resolve()
        .then(() => entry.commit(entry.value))
        .catch(() => undefined);
    }
    return last.current;
  }, []);

  const schedule = useCallback(
    (value: T, commit: (value: T) => unknown) => {
      pending.current = { value, commit };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    pending.current = null;
  }, []);

  useEffect(() => () => void flush(), [flush]);

  return { schedule, flush, cancel };
}
