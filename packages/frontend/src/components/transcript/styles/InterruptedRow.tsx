import { useTranslation } from 'react-i18next';

/**
 * ユーザーによる中断（停止ボタン等）を表す終端行。全表示スタイル共通コンポーネント（SystemOtherChip と
 * 同様の位置付け）。中断はエラーでも警告でもないため、ステータスカラーの左ボーダー等は使わず、
 * `--text-dim` の控えめな1行テキストのみで表現する。
 */
export function InterruptedRow() {
  const { t } = useTranslation('transcript');
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
        margin: '10px 0',
        fontSize: 'var(--font-xs)',
        color: 'var(--text-dim)',
      }}
    >
      <span aria-hidden="true">⏹</span>
      <span>{t('conversation.interrupted')}</span>
    </div>
  );
}
