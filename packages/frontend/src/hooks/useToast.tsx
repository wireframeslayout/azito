import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OPERATOR_REQUIRED_EVENT, type OperatorRequiredEventDetail } from '../api/operatorRequired';
import { Button } from '../components/ui/Button';

const TOAST_DURATION = { base: 3000, perCodePoint: 100, actionMinimum: 10000, maximum: 30000 };

function getDuration(message: string, hasActions: boolean): number {
  return Math.min(TOAST_DURATION.maximum, Math.max(
    hasActions ? TOAST_DURATION.actionMinimum : TOAST_DURATION.base,
    TOAST_DURATION.base + Array.from(message).length * TOAST_DURATION.perCodePoint,
  ));
}

interface ToastAction { label: string; onClick: () => void }
interface ToastContextValue {
  showToast: (msg: string, actions?: ToastAction[]) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common');
  const [toast, setToast] = useState<{ message: string; actions: ToastAction[] } | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const durationRef = useRef(0);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const scheduleHide = useCallback(() => {
    clearTimeout(timerRef.current);
    if (!hoveredRef.current && !focusedRef.current) {
      timerRef.current = setTimeout(() => setToast(null), durationRef.current);
    }
  }, []);
  const showToast = useCallback((msg: string, actions: ToastAction[] = []) => {
    durationRef.current = getDuration(msg, actions.length > 0);
    setToast({ message: msg, actions });
    scheduleHide();
  }, [scheduleHide]);
  const dismiss = useCallback(() => {
    clearTimeout(timerRef.current);
    hoveredRef.current = false;
    focusedRef.current = false;
    setToast(null);
  }, []);
  const dismissAndRestoreFocus = useCallback(() => {
    const restoreFocus = toastRef.current?.contains(document.activeElement) ? previousFocusRef.current : null;
    dismiss();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  }, [dismiss]);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useLayoutEffect(() => {
    if (!toast) return;
    const hasFocus = toastRef.current?.contains(document.activeElement) ?? false;
    if (focusedRef.current !== hasFocus) {
      focusedRef.current = hasFocus;
      scheduleHide();
    }
  }, [toast, scheduleHide]);

  // Issue #28 Phase D-1: the browser normally runs as an `operator`
  // principal and should never see this 403 — it surfaces only when the
  // stored token is actually task-shaped (see api/operatorRequired.ts's doc
  // comment). Reported via a plain `window` event because api/client.ts is
  // not a React component and cannot call `showToast` directly.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OperatorRequiredEventDetail>).detail;
      showToast(t('errors.operatorRequired', { operation: detail.operation }));
    };
    window.addEventListener(OPERATOR_REQUIRED_EVENT, handler);
    return () => window.removeEventListener(OPERATOR_REQUIRED_EVENT, handler);
  }, [showToast, t]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        ref={toastRef}
        className={toast ? undefined : 'sr-only'}
        onMouseEnter={() => { hoveredRef.current = true; clearTimeout(timerRef.current); }}
        onMouseLeave={() => { hoveredRef.current = false; scheduleHide(); }}
        onFocus={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            previousFocusRef.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
          }
          focusedRef.current = true;
          clearTimeout(timerRef.current);
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          focusedRef.current = false;
          scheduleHide();
        }}
        style={toast ? {
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)',
          position: 'absolute', bottom: 'var(--space-5)', left: '50%', transform: 'translateX(-50%)',
          width: 'max-content', maxWidth: 'calc(100% - 2 * var(--space-4))', boxSizing: 'border-box',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          padding: 'var(--space-2) var(--space-4)', fontSize: 'var(--font-md)', color: 'var(--text)', zIndex: 300,
          boxShadow: 'var(--shadow-2)',
        } : undefined}>
        <span aria-live="polite" aria-atomic="true" style={{ flex: '1 1 0', minWidth: 0, overflowWrap: 'anywhere' }}>{toast?.message ?? ''}</span>
        {toast?.actions.map((action) => <Button key={action.label} type="button" variant="ghost" size="sm" className="toast-action" onClick={() => { dismissAndRestoreFocus(); action.onClick(); }}>{action.label}</Button>)}
        {toast && <Button type="button" variant="ghost" size="sm" className="toast-action toast-close" aria-label={t('toast.close')} onClick={dismissAndRestoreFocus}>{t('actions.close')}</Button>}
      </div>
    </ToastContext.Provider>
  );
}
