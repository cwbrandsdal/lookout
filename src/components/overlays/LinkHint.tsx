import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placeTooltip } from './position';

interface HintState {
  text: string;
  x: number;
  y: number;
}

/** Tooltip for terminal links, driven by `lookout:link-hint` ({ text: string | null, x, y }). */
export function LinkHint() {
  const [hint, setHint] = useState<HintState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onHint = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string | null; x: number; y: number } | undefined>).detail;
      setHint(detail?.text ? { text: detail.text, x: detail.x, y: detail.y } : null);
    };
    window.addEventListener('lookout:link-hint', onHint);
    return () => window.removeEventListener('lookout:link-hint', onHint);
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !hint) {
      return;
    }
    const point = placeTooltip(
      { x: hint.x, y: hint.y },
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${Math.round(point.x)}px`;
    element.style.top = `${Math.round(point.y)}px`;
    element.style.visibility = 'visible';
  }, [hint]);

  if (!hint) {
    return null;
  }
  return (
    <div ref={ref} className="ov-link-hint" role="tooltip">
      {hint.text}
    </div>
  );
}
