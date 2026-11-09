import { forwardRef, useEffect, useRef, type HTMLAttributes } from 'react';

interface GlassPopoverSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onOutside: (event: PointerEvent) => void;
}

export const GlassPopoverSurface = forwardRef<HTMLDivElement, GlassPopoverSurfaceProps>(function GlassPopoverSurface({ open, onOutside, children, ...props }, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const listener = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onOutside(event); };
    document.addEventListener('pointerdown', listener);
    return () => document.removeEventListener('pointerdown', listener);
  }, [open, onOutside]);
  return <div {...props} ref={node => { ref.current = node; if (typeof forwardedRef === 'function') forwardedRef(node); else if (forwardedRef) forwardedRef.current = node; }} className={`glass-popover ${props.className ?? ''}`}>{children}</div>;
});
