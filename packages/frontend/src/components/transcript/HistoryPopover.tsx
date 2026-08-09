import { useTranslation } from 'react-i18next';
import { useClickOutside } from '../../hooks/useClickOutside';
import { loadHistory } from './inputHistory';

const MAX_SHOWN = 10;

interface HistoryPopoverProps {
  /** 履歴エントリをタップした時。送信はしない（テキスト挿入のみ）。 */
  onSelect: (text: string) => void;
  onClose: () => void;
}

/**
 * 入力バーの🕘ボタン直上に開く送信履歴ポップオーバー（F4）。開く時点の localStorage を
 * 都度読み直す（履歴は入力バー側で状態管理していないため）。最新10件のみ表示。
 */
export function HistoryPopover({ onSelect, onClose }: HistoryPopoverProps) {
  const { t } = useTranslation('transcript');
  const ref = useClickOutside<HTMLDivElement>(onClose);
  const entries = loadHistory().slice(0, MAX_SHOWN);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('promptBar.history')}
      style={{
        position: 'absolute',
        bottom: '100%',
        right: 0,
        marginBottom: 6,
        zIndex: 100,
        background: 'var(--bg-solid)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-2)',
        minWidth: 240,
        maxWidth: 'min(360px, calc(100vw - 32px))',
        maxHeight: 320,
        overflowY: 'auto',
        padding: 6,
      }}
    >
      {entries.length === 0 ? (
        <div style={{ padding: '10px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('promptBar.historyEmpty')}
        </div>
      ) : (
        entries.map((entry, index) => (
          <button
            key={index}
            type="button"
            role="menuitem"
            className="row-hover"
            onClick={() => onSelect(entry)}
            style={{
              display: 'block',
              width: '100%',
              border: 'none',
              background: 'none',
              color: 'var(--text)',
              fontFamily: 'inherit',
              fontSize: 'var(--font-sm)',
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry}
          </button>
        ))
      )}
    </div>
  );
}
