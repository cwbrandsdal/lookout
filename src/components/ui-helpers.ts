import { useEffect, useState } from 'react';

export const TAB_MIME = 'application/x-lookout-tab';

/** Current time, refreshed every second while `live` (running-command timers). */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      return;
    }
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [live]);
  return now;
}

export function profileGlyph(kind?: string): string {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return '❯';
    case 'cmd':
      return '>';
    case 'bash':
      return '$';
    case 'wsl':
      return '🐧';
    case 'ssh':
      return '⇄';
    default:
      return '›';
  }
}
