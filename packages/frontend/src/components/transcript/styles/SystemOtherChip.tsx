import { useTranslation } from 'react-i18next';
import type { TranscriptEntryType } from '../transcriptTypes';

interface SystemOtherChipProps {
  entryType: Extract<TranscriptEntryType, 'system' | 'other'>;
  children: React.ReactNode;
}

/** system / other グループ用の中央寄せチップ表示。全表示スタイル共通コンポーネント。 */
export function SystemOtherChip({ entryType, children }: SystemOtherChipProps) {
  const { t } = useTranslation('transcript');
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
      <div
        style={{
          maxWidth: '90%',
          padding: '6px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
        }}
      >
        <span style={{ fontWeight: 600, marginRight: 6 }}>
          {entryType === 'system' ? t('conversation.system') : t('conversation.other')}
        </span>
        {children}
      </div>
    </div>
  );
}
