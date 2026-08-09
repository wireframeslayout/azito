import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';

interface ConversationMenuProps {
  sessionId: string;
}

/**
 * 会話ヘッダー右端の「…」メニュー。ヘッダー1段化でタイトルから追い出したセッションID全文を、
 * ここでコピー可能な形で表示する。位置決め・外側クリック/Esc で閉じる挙動は StyleSwitcher に合わせている。
 */
export function ConversationMenu({ sessionId }: ConversationMenuProps) {
  const { t } = useTranslation('transcript');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPanelPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
    setCopied(false);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
    } catch {
      // クリップボード権限が無い環境では単に無反応にする（コピーは補助機能）。
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('conversation.menu.ariaLabel')}
        title={t('conversation.menu.ariaLabel')}
        className="icon-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 38,
          height: 38,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          background: open ? 'var(--bg-hover)' : 'transparent',
          color: 'var(--text-dim)',
          cursor: 'pointer',
        }}
      >
        <Icon name="more-vertical" size={16} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('conversation.menu.ariaLabel')}
          style={{
            position: 'fixed',
            top: panelPos.top,
            right: panelPos.right,
            zIndex: 300,
            minWidth: 240,
            maxWidth: 'min(360px, calc(100vw - 32px))',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-solid)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-2)',
            padding: 6,
            overflow: 'hidden',
          }}
        >
          <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '4px 10px' }}>
            {t('conversation.menu.sessionId')}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className="row-hover"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              border: 'none',
              background: 'none',
              color: 'var(--text)',
              fontFamily: 'inherit',
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 'var(--font-xs)', wordBreak: 'break-all' }}>
              {sessionId}
            </span>
            <Icon name={copied ? 'check' : 'copy'} size={14} style={{ color: copied ? 'var(--accent)' : 'var(--text-dim)' }} />
          </button>
        </div>
      )}
    </div>
  );
}
