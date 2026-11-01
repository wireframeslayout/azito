import { useTranslation } from 'react-i18next';
import { computeThinkingGapSeconds, formatEntryTimestamp, taskNotificationSummary } from '../transcriptFormat';
import type { TranscriptEntry } from '../transcriptTypes';
import { CommandRow } from './CommandRow';
import { GroupHeading } from './GroupHeading';
import { InteractionCard } from './InteractionCard';
import { InterruptedRow } from './InterruptedRow';
import { SystemEntryText } from './SystemEntryText';
import { SystemOtherChip } from './SystemOtherChip';
import { BlockList } from './BlockList';
import { buildBlockSegments, type BlockSegment } from '../groupToolBlocks';
import { ToolRunGroup } from '../ToolRunGroup';
import type { StyleGroupProps } from './types';

// モックアップ A1 指定値。既存トークンに 86% 幅に対応するものが無いため直接指定する。
const BUBBLE_MAX_WIDTH = '86%';

/** グループ内の各エントリを縦に連結して描画する（B1: ロールグルーピング）。gap は小さめ。 */
function GroupEntries({ entries, prevTimestamp, isUser }: {
  entries: TranscriptEntry[];
  prevTimestamp: string | null;
  isUser: boolean;
}) {
  const renderSegment = (segment: BlockSegment) => {
    const content = segment.blocks.map((item) => <BlockList key={item.key} blocks={[item.block]} markdownText={item.markdownText} thinkingSeconds={item.thinkingSeconds} />);
    if (segment.isToolRun) return <ToolRunGroup blocks={segment.blocks}>{content}</ToolRunGroup>;
    if (segment.entryType !== 'tool') return <div style={{ padding: 'var(--space-3) var(--space-4)', borderRadius: isUser ? 'var(--radius-lg) var(--radius-lg) var(--space-1) var(--radius-lg)' : 'var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--space-1)', background: isUser ? 'var(--accent-a15)' : 'var(--bg-card)', minWidth: 0, maxWidth: '100%' }}>{content}</div>;
    return content;
  };
  return <>{buildBlockSegments(entries, prevTimestamp).map((segment, i) => (
    <div key={segment.key} style={{ marginTop: i > 0 ? 'var(--space-1)' : 0, minWidth: 0, maxWidth: '100%' }}>
      {renderSegment(segment)}
    </div>
  ))}</>;
}

/**
 * バブルスタイル（モックアップ A1）。user は右寄せ・accent 面、assistant は左寄せ・カード面。
 * 境界線は使わず、面色と角丸のみで発話者を区別する。
 * ロールグルーピング（B1）: 連続する同一種別のエントリは1グループとして扱い、見出しと時刻は
 * グループにつき1回だけ描画する。
 */
export default function BubbleEntry({ group, prevTimestamp, agentLabel }: StyleGroupProps) {
  const { i18n } = useTranslation('transcript');
  const lastEntry = group.entries[group.entries.length - 1];
  const timeLabel = formatEntryTimestamp(lastEntry.timestamp, i18n.language);

  if (group.type === 'tool') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '4px 0' }}>
        <div style={{ maxWidth: BUBBLE_MAX_WIDTH, minWidth: 0, width: '100%' }}>
          <GroupEntries entries={group.entries} prevTimestamp={prevTimestamp} isUser={false} />
        </div>
      </div>
    );
  }

  if (group.type === 'interrupted') {
    return (
      <>
        {group.entries.map((entry) => <InterruptedRow key={entry.uuid} />)}
      </>
    );
  }

  if (group.type === 'command') {
    return (
      <>
        {group.entries.map((entry) => <CommandRow key={entry.uuid} entry={entry} />)}
      </>
    );
  }

  if (group.type === 'interaction') {
    return (
      <>
        {group.entries.map((entry) => <InteractionCard key={entry.uuid} entry={entry} />)}
      </>
    );
  }

  if (group.type === 'system' || group.type === 'other') {
    let prevTs = prevTimestamp;
    return (
      <SystemOtherChip entryType={group.type}>
        {group.entries.map((entry) => {
          const thinkingSeconds = computeThinkingGapSeconds(prevTs, entry.timestamp);
          prevTs = entry.timestamp;
          const notification = taskNotificationSummary(entry);
          if (notification !== null) return <SystemEntryText key={entry.uuid} entry={entry} />;
          return <BlockList key={entry.uuid} blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />;
        })}
      </SystemOtherChip>
    );
  }

  const isUser = group.type === 'user';
  const groupModel = !isUser ? [...group.entries].reverse().find((entry) => entry.model)?.model : undefined;

  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', margin: '10px 0 8px' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: isUser ? 'flex-end' : 'flex-start',
          maxWidth: BUBBLE_MAX_WIDTH,
          minWidth: 0,
        }}
      >
        <GroupHeading isUser={isUser} timeLabel={timeLabel} agentLabel={agentLabel} model={groupModel} />
        <GroupEntries entries={group.entries} prevTimestamp={prevTimestamp} isUser={isUser} />
      </div>
    </div>
  );
}
