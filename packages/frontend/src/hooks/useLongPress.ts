import { useCallback, useEffect, useRef } from 'react';

const MOVE_THRESHOLD_SQ = 100; // 10px squared

export const longPressStyle: React.CSSProperties = {
  WebkitUserSelect: 'none',
  userSelect: 'none',
  WebkitTouchCallout: 'none',
} as React.CSSProperties;

export function useLongPress(ms = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const firedRef = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const suppressRef = useRef<{ el: HTMLElement; handler: (ev: Event) => void } | null>(null);

  function cleanupSuppress() {
    if (suppressRef.current) {
      suppressRef.current.el.removeEventListener('contextmenu', suppressRef.current.handler);
      suppressRef.current = null;
    }
  }

  const bind = useCallback((onLongPress: (x: number, y: number) => void) => ({
    onTouchStart: (e: React.TouchEvent) => {
      firedRef.current = false;
      const touch = e.touches[0];
      const x = touch.clientX;
      const y = touch.clientY;
      startPos.current = { x, y };
      cleanupSuppress();
      const el = e.currentTarget as HTMLElement;
      const handler = (ev: Event) => { ev.preventDefault(); cleanupSuppress(); };
      el.addEventListener('contextmenu', handler, { once: true });
      suppressRef.current = { el, handler };
      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        onLongPress(x, y);
      }, ms);
    },
    onTouchEnd: (e: React.TouchEvent) => {
      clearTimeout(timerRef.current);
      if (firedRef.current) {
        e.preventDefault();
        firedRef.current = false;
      } else {
        cleanupSuppress();
      }
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      const dx = t.clientX - startPos.current.x;
      const dy = t.clientY - startPos.current.y;
      if (dx * dx + dy * dy > MOVE_THRESHOLD_SQ) {
        clearTimeout(timerRef.current);
        cleanupSuppress();
      }
    },
  }), [ms]);

  useEffect(() => () => { clearTimeout(timerRef.current); cleanupSuppress(); }, []);

  return bind;
}
