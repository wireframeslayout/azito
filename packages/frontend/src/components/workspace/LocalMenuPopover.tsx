import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface LocalMenuPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorY: number;
  children: React.ReactNode;
}

export default function LocalMenuPopover({ open, onClose, anchorY, children }: LocalMenuPopoverProps) {
  const { t } = useTranslation('workspace');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('menu.sidebarContent')}
      style={{
        position: 'fixed',
        left: 96, /* GlobalMenu(48) + LocalMenu(48) */
        top: Math.max(8, anchorY - 10),
        width: 320,
        maxHeight: 'calc(100vh - 32px)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 14px 36px rgba(0,0,0,.55)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 130,
        // ポップオーバー配下では中身の .ws-surface 系を不透明化する（ポップオーバー外の
        // 通常サイドバー表示には影響しない、このコンポーネント内のみのローカル上書き）
        ['--ws-surface' as string]: 'var(--bg-elevated)',
        ['--ws-surface-card' as string]: 'var(--bg-elevated)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: -5,
          top: 18,
          width: 8,
          height: 8,
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          transform: 'rotate(45deg)',
        }}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
