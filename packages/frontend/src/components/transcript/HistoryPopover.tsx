import { useTranslation } from 'react-i18next';
import { useClickOutside } from '../../hooks/useClickOutside';

const MAX_SHOWN = 10;
const PREVIEW_MAX_CHARS = 120;

/** 一覧表示用のプレビューを作る: 複数行は1行目のみ、さらに先頭120字でトリムする。選択時は元の全文を渡す。 */
function previewOf(entry: string): string {
  const firstLine = entry.split('\n', 1)[0];
  return firstLine.length > PREVIEW_MAX_CHARS ? `${firstLine.slice(0, PREVIEW_MAX_CHARS)}…` : firstLine;
}

interface HistoryPopoverProps {
  /**
   * 表示候補の履歴（新しい順）。呼び出し側（PromptInputBar）が、会話トランスクリプトの
   * user 発話を主ソース、localStorage のローカル送信履歴をフォールバックとして解決済みの値を渡す
   * （Issue #69 仕様調整4）。
   */
  entries: string[];
  /** 履歴エントリをタップした時。送信はしない（テキスト挿入のみ）。 */
  onSelect: (text: string) => void;
  onClose: () => void;
}

/**
 * 入力バーの🕘ボタン直上に開く送信履歴ポップオーバー（F4）。最新10件のみ表示。
 */
export function HistoryPopover({ entries: allEntries, onSelect, onClose }: HistoryPopoverProps) {
  const { t } = useTranslation('transcript');
  const ref = useClickOutside<HTMLDivElement>(onClose);
  const entries = allEntries.slice(0, MAX_SHOWN);

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
            {previewOf(entry)}
          </button>
        ))
      )}
      {/* Ctrl/Cmd+Enter送信のヒントは placeholder から移設（SP実機の3行折返し対策、F5）。 */}
      <div
        style={{
          marginTop: 4,
          padding: '6px 10px 2px',
          borderTop: '1px solid var(--border)',
          fontSize: 'var(--font-2xs)',
          color: 'var(--text-dim)',
        }}
      >
        {t('promptBar.sendShortcutHint')}
      </div>
    </div>
  );
}
