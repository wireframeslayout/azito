import { cycleFocus, getFocusableElements } from './overlayLogic';
import { useHotkey, useOverlayStack } from '../../hooks/useHotkeys';
import { parseKeySpec } from '../../lib/hotkeys/keySpec';
import { useEffect, useRef, useState } from 'react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  hideTitle?: boolean;
  children: React.ReactNode;
}

export function BottomSheet({ open, onClose, title, hideTitle, children }: BottomSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { id, isTop } = useOverlayStack(open, ref, true);
  useHotkey({ action: 'local:overlay-close', spec: parseKeySpec('Escape'), scope: 'overlay', overlayId: id, handler: onClose }, open);
  const [shouldRender, setShouldRender] = useState(open);

  useEffect(() => {
    if (open && ref.current) (ref.current.querySelector<HTMLElement>('[data-initial-focus]') ?? getFocusableElements(ref.current)[0] ?? ref.current).focus();
  }, [open, shouldRender]);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      return;
    }
    const timer = window.setTimeout(() => setShouldRender(false), 250);
    return () => window.clearTimeout(timer);
  }, [open]);


  return (
    <>
      {open && (
        <div
          onClick={() => { if (isTop) onClose(); }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 129,
          }}
        />
      )}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => { if (isTop && ref.current) cycleFocus(event.nativeEvent, ref.current); }}
        inert={!open}
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(22, 27, 34, 0.92)',
          backdropFilter: 'blur(16px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.5)',
          padding: 6,
          paddingBottom: 'calc(6px + env(safe-area-inset-bottom))',
          zIndex: 130,
          maxHeight: '70vh',
          overflowY: 'auto',
          border: '1px solid rgba(139, 148, 158, 0.25)',
          borderBottom: 'none',
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          opacity: open ? 1 : 0,
          visibility: open ? 'visible' : 'hidden',
          pointerEvents: open ? 'auto' : 'none',
          transition: 'transform 0.25s ease, opacity 0.2s ease, visibility 0.25s ease',
        }}
      >
        {title && !hideTitle && (
          <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '6px 10px 4px' }}>
            {title}
          </div>
        )}
        {shouldRender ? children : null}
      </div>
    </>
  );
}
