import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  maxWidth?: number | string;
  maxHeight?: string;
}

export default function Modal({ title, open, onClose, actions, children, maxWidth = 500, maxHeight = '90vh' }: ModalProps) {
  const { t } = useTranslation('common');
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'inset 0 1px 0 var(--edge-hi), var(--shadow-3)',
          padding: 20,
          width: '100%',
          maxWidth,
          maxHeight,
          overflowY: 'auto',
        }}
      >
        <h2 style={{ fontSize: 'var(--font-lg)', marginBottom: 16 }}>{title}</h2>
        <div>{children}</div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 16,
          }}
        >
          <Button onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          {actions}
        </div>
      </div>
    </div>
  );
}
