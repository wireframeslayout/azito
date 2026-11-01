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

/**
 * user ターンのみカード面を敷き、assistant/tool はロール行の下にそのまま続ける。
 * グループ内の各エントリを縦に連結して描画する（B1: ロールグルーピング）。gap は小さめ。
 */
function GroupEntries({ entries, prevTimestamp, isUser }: {
  entries: TranscriptEntry[];
  prevTimestamp: string | null;
  isUser: boolean;
}) {
  const renderSegment = (segment: BlockSegment) => {
    const content = segment.blocks.map((item) => <BlockList key={item.key} blocks={[item.block]} markdownText={item.markdownText} thinkingSeconds={item.thinkingSeconds} />);
    if (segment.isToolRun) return <ToolRunGroup blocks={segment.blocks}>{content}</ToolRunGroup>;
    if (isUser && segment.entryType === 'user') return <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-3) var(--space-4)' }}>{content}</div>;
    return content;
  };
  return <>{buildBlockSegments(entries, prevTimestamp).map((segment, i) => (
    <div key={segment.key} style={{ marginTop: i > 0 ? 'var(--space-2)' : 0, minWidth: 0, maxWidth: '100%' }}>
      {renderSegment(segment)}
    </div>
  ))}</>;
}

/**
 * フロースタイル（モックアップ A2・既定）。バブルを廃止し、各ターンを全幅表示する。
 * ロールグルーピング（B1）: 連続する同一種別のエントリは1グループとして扱い、見出しと時刻は
 * グループにつき1回だけ描画する。
 */
export default function FlowEntry({ group, prevTimestamp, agentLabel }: StyleGroupProps) {
  const { i18n } = useTranslation('transcript');
  const lastEntry = group.entries[group.entries.length - 1];
  const timeLabel = formatEntryTimestamp(lastEntry.timestamp, i18n.language);

  if (group.type === 'tool') {
    return (
      <div style={{ margin: '2px 0 14px' }}>
        <GroupEntries entries={group.entries} prevTimestamp={prevTimestamp} isUser={false} />
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
    <div style={{ margin: '14px 0' }}>
      <GroupHeading isUser={isUser} timeLabel={timeLabel} agentLabel={agentLabel} model={groupModel} />
      <GroupEntries entries={group.entries} prevTimestamp={prevTimestamp} isUser={isUser} />
    </div>
  );
}
