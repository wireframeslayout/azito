import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useHotkey, useHotkeyBindings, useOverlayStack, type HotkeyAction } from '../../hooks/useHotkeys';
import { parseKeySpec } from '../../lib/hotkeys/keySpec';
import { cycleFocus, getFocusableElements } from './overlayLogic';
import { shouldCloseOnKey } from '../modalEscape';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  variant?: 'dialog' | 'alert';
  surface?: 'elevated' | 'solid';
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  dismissOnBackdrop?: boolean;
  closeDisabled?: boolean;
  busy?: boolean;
  toggleAction?: HotkeyAction;
  maxWidth?: number | string;
  maxHeight?: string;
  style?: CSSProperties;
}

export function Overlay({ open, onClose, labelledBy, children, variant = 'dialog', surface = 'elevated', initialFocusRef, dismissOnBackdrop = true, closeDisabled = false, busy = false, toggleAction, maxWidth = 500, maxHeight = '90vh', style }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { id, isTop } = useOverlayStack(open, ref, true);
  const { bindings } = useHotkeyBindings();
  const spec = toggleAction ? bindings[toggleAction] : null;
  const spaceChord = spec?.steps.length === 2 && spec.steps.every(step => step.key === 'space');
  useHotkey({ action: toggleAction ?? 'local:disabled-toggle', scope: 'overlay', overlayId: id, when: spaceChord ? 'not-editable' : 'always', handler: () => onClose() }, open && !!toggleAction);
  useHotkey({ action: 'local:overlay-close', spec: parseKeySpec('Escape'), scope: 'overlay', overlayId: id, handler: event => { if (shouldCloseOnKey(event)) onClose(); } }, open && !closeDisabled && !busy);

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    if (initialFocusRef?.current) { initialFocusRef.current.focus(); return; }
    if (container.contains(document.activeElement)) return;
    (getFocusableElements(container)[0] ?? container).focus();
  }, [open, initialFocusRef]);

  if (!open) return null;
  return createPortal(
    <div className="overlay-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && isTop && dismissOnBackdrop && !closeDisabled && !busy) onClose();
    }}>
      <div ref={ref} onKeyDown={event => { if (isTop && ref.current) cycleFocus(event.nativeEvent, ref.current); }} role={variant === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={labelledBy} aria-busy={busy || undefined} tabIndex={-1} className="overlay-panel" style={{ maxWidth, maxHeight, background: surface === 'solid' ? 'var(--bg-solid)' : 'var(--bg-elevated)', ...style }}>
        {children}
      </div>
    </div>, document.body,
  );
}
