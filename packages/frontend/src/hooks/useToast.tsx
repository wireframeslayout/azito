import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OPERATOR_REQUIRED_EVENT, type OperatorRequiredEventDetail } from '../api/operatorRequired';

interface ToastContextValue {
  showToast: (msg: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common');
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

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
      {toast && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          padding: '8px 20px', fontSize: 'var(--font-md)', color: 'var(--text)', zIndex: 300,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {toast}
        </div>
      )}
    </ToastContext.Provider>
  );
}
