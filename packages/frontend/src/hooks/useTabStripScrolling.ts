import { useCallback, useEffect, useRef } from 'react';

/**
 * Wires wheel-to-horizontal-scroll and auto-scroll-active-tab-into-view behavior for a
 * horizontally-scrolling tab strip (`overflowX: 'auto'`), shared by `TabBar` and
 * `MiniTabBar` so the two never drift into two independently-maintained (and possibly
 * inconsistent) copies of the same behavior. Without this, a tab strip narrower than its
 * content only scrolls via the (easy to miss) native horizontal scrollbar/shift-wheel — the
 * child buttons carry `data-tab-id` (already required by both call sites) so the active one
 * can be located and scrolled into view.
 *
 * Returns `attachRef` — pass it as the scrolling strip element's `ref`. `elRef` is exposed
 * too, for callers (e.g. `TabBar`'s mouse-based reorder drag) that already need direct
 * access to the same element and would otherwise have to track a second ref pointing at the
 * identical node.
 */
export function useTabStripScrolling(activeKey: string | null) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);

  const attachWheelListener = useCallback((el: HTMLDivElement | null) => {
    if (wheelCleanupRef.current) { wheelCleanupRef.current(); wheelCleanupRef.current = null; }
    if (el) {
      const handler = (e: WheelEvent) => { e.preventDefault(); el.scrollLeft += e.deltaY; };
      el.addEventListener('wheel', handler, { passive: false });
      wheelCleanupRef.current = () => el.removeEventListener('wheel', handler);
    }
  }, []);

  const attachRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    attachWheelListener(el);
  }, [attachWheelListener]);

  useEffect(() => {
    return () => {
      wheelCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!activeKey || !elRef.current) return;
    const timer = setTimeout(() => {
      if (!elRef.current) return;
      const el = elRef.current.querySelector(`[data-tab-id="${CSS.escape(activeKey)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }, 100);
    return () => clearTimeout(timer);
  }, [activeKey]);

  return { attachRef, elRef };
}
