import { useTranslation } from 'react-i18next';
import { THINKING_HAIRLINE_COLOR } from './mockupColors';

interface ThinkingChipProps {
  text: string;
  /** 直前エントリとの経過秒数（1〜300秒の場合のみ表示）。computeThinkingGapSeconds の戻り値。 */
  seconds: number | null;
}

/**
 * thinking ブロックの折りたたみ痕跡チップ（C2）。全表示スタイル共通コンポーネント。
 * 既定閉。開くと斜体本文の左に magenta 系の細い縦線を表示する。
 */
export function ThinkingChip({ text, seconds }: ThinkingChipProps) {
  const { t } = useTranslation('transcript');
  const label = seconds !== null
    ? t('conversation.thinkingWithSeconds', { seconds })
    : t('conversation.thinking');

  return (
    <details style={{ margin: '6px 0' }}>
      <summary
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 10px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--bg-hover)',
          color: 'var(--text-dim)',
          fontSize: 'var(--font-xs)',
          cursor: 'pointer',
          userSelect: 'none',
          listStyle: 'none',
        }}
      >
        <span aria-hidden="true">✳</span>
        {label}
      </summary>
      <div
        style={{
          marginTop: 4,
          padding: '2px 10px',
          borderLeft: `2px solid ${THINKING_HAIRLINE_COLOR}`,
          fontStyle: 'italic',
          color: 'var(--text-dim)',
          fontSize: 'var(--font-xs)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </details>
  );
}
