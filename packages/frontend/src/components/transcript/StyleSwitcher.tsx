import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { TRANSCRIPT_STYLES, type TranscriptStyle } from './transcriptStyle';

interface StyleSwitcherProps {
  value: TranscriptStyle;
  onChange: (style: TranscriptStyle) => void;
}

/**
 * トランスクリプト表示スタイルの切替ドロップダウン。ConversationView のヘッダー右側に置く。
 * 位置決め・外側クリック/Esc で閉じる挙動は UsageDropdown の慣習に合わせている。
 */
export function StyleSwitcher({ value, onChange }: StyleSwitcherProps) {
  const { t } = useTranslation('transcript');
  const [open, setOpen] = useState(false);
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
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('styleSwitcher.ariaLabel')}
        className="icon-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          background: open ? 'var(--bg-hover)' : 'transparent',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          fontSize: 'var(--font-sm)',
          whiteSpace: 'nowrap',
        }}
      >
        {t(`styleSwitcher.option.${value}`)}
        <Icon name="chevrons-up-down" size={14} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('styleSwitcher.ariaLabel')}
          style={{
            position: 'fixed',
            top: panelPos.top,
            right: panelPos.right,
            zIndex: 300,
            minWidth: 150,
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-solid)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-2)',
            padding: 4,
            overflow: 'hidden',
          }}
        >
          {TRANSCRIPT_STYLES.map((style) => {
            const selected = style === value;
            return (
              <button
                key={style}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { onChange(style); setOpen(false); }}
                className={selected ? 'row-hover row-selected' : 'row-hover'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  border: 'none',
                  color: selected ? 'var(--accent)' : 'var(--text)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--font-sm)',
                  fontWeight: selected ? 600 : 400,
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {t(`styleSwitcher.option.${style}`)}
                {selected && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
