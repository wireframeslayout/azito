import { useCallback, useEffect, useRef, useState } from 'react';

export function useVisibleIds(root: Element | null): { visibleIds: Set<number>; register: (id: number, node: Element | null) => void } {
  const [visibleIds, setVisibleIds] = useState<Set<number>>(() => new Set());
  const nodes = useRef(new Map<number, Element>());
  const observer = useRef<IntersectionObserver | null>(null);
  const setVisible = useCallback((id: number, visible: boolean) => {
    setVisibleIds((previous) => {
      if (previous.has(id) === visible) return previous;
      const next = new Set(previous);
      if (visible) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const register = useCallback((id: number, node: Element | null) => {
    const previous = nodes.current.get(id);
    if (previous === node) return;
    if (previous) observer.current?.unobserve(previous);
    nodes.current.delete(id);
    setVisible(id, false);
    if (node) { nodes.current.set(id, node); observer.current?.observe(node); }
  }, [setVisible]);
  useEffect(() => {
    if (!root) return;
    const instance = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        for (const [id, node] of nodes.current) {
          if (entry.target === node) setVisible(id, entry.isIntersecting);
        }
      }
    }, { root, rootMargin: '120px' });
    observer.current = instance;
    for (const node of nodes.current.values()) instance.observe(node);
    return () => { instance.disconnect(); observer.current = null; setVisibleIds(new Set()); };
  }, [root, setVisible]);
  return { visibleIds, register };
}
