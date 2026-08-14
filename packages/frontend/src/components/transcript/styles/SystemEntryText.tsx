import { useTranslation } from 'react-i18next';
import { taskNotificationSummary } from '../transcriptFormat';
import type { TranscriptEntry } from '../transcriptTypes';

/**
 * systemKind === 'task_notification'（`<task-notification>` 生XML整形、Issue #338 フェーズA）の
 * エントリを「バックグラウンドタスク: {{summary}}」の専用文言で描画する。全表示スタイル共通。
 * 該当しないエントリは null を返す — 呼び出し側は通常の BlockList/EntryBlocks 描画にフォールバックする。
 */
export function SystemEntryText({ entry }: { entry: TranscriptEntry }) {
  const { t } = useTranslation('transcript');
  const summary = taskNotificationSummary(entry);
  if (summary === null) return null;

  const text = summary.length > 0 ? t('conversation.taskNotification', { summary }) : t('conversation.taskNotificationNoSummary');
  return <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>;
}
