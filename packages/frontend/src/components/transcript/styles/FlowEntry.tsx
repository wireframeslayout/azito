import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../../MarkdownRenderer';
import { CollapsibleBlock } from '../CollapsibleBlock';
import { computeThinkingGapSeconds, formatEntryTimestamp } from '../transcriptFormat';
import type { TranscriptBlock, TranscriptEntry } from '../transcriptTypes';
import { GroupHeading } from './GroupHeading';
import { SystemOtherChip } from './SystemOtherChip';
import { ThinkingChip } from './ThinkingChip';
import type { StyleGroupProps } from './types';

function TextBlock({ text, markdown }: { text: string; markdown: boolean }) {
  if (markdown) {
    return <MarkdownRenderer content={text} style={{ fontSize: 'var(--font-base)' }} />;
  }
  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--font-base)', lineHeight: 1.6 }}>
      {text}
    </div>
  );
}

function BlockList({ blocks, markdownText, thinkingSeconds }: {
  blocks: TranscriptBlock[];
  markdownText: boolean;
  thinkingSeconds: number | null;
}) {
  const { t } = useTranslation('transcript');

  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'text':
            return <TextBlock key={i} text={block.text} markdown={markdownText} />;
          case 'thinking':
            return <ThinkingChip key={i} text={block.text} seconds={thinkingSeconds} />;
          case 'tool_use':
            return (
              <CollapsibleBlock
                key={i}
                icon="terminal"
                label={t('conversation.toolChip', { name: block.name })}
                expandedLabel={t('conversation.toolUse', { name: block.name })}
                truncatedNote={block.truncated ? t('conversation.blockTruncated') : undefined}
              >
                {block.input}
              </CollapsibleBlock>
            );
          case 'tool_result':
            return (
              <CollapsibleBlock
                key={i}
                icon="file"
                tone={block.isError ? 'danger' : 'default'}
                status={block.isError ? 'error' : 'success'}
                label={block.isError ? t('conversation.toolResultChipError') : t('conversation.toolResultChip')}
                expandedLabel={block.isError ? t('conversation.toolResultError') : t('conversation.toolResult')}
                truncatedNote={block.truncated ? t('conversation.blockTruncated') : undefined}
              >
                {block.text}
              </CollapsibleBlock>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * user ターンのみカード面を敷き、assistant/tool はロール行の下にそのまま続ける。
 * グループ内の各エントリを縦に連結して描画する（B1: ロールグルーピング）。gap は小さめ。
 */
function GroupEntries({ entries, prevTimestamp, isUser }: {
  entries: TranscriptEntry[];
  prevTimestamp: string | null;
  isUser: boolean;
}) {
  let prevTs = prevTimestamp;

  return (
    <>
      {entries.map((entry, i) => {
        const thinkingSeconds = computeThinkingGapSeconds(prevTs, entry.timestamp);
        prevTs = entry.timestamp;
        const marginTop = i > 0 ? 6 : 0;
        const markdownText = entry.type === 'assistant';
        const content = <BlockList blocks={entry.blocks} markdownText={markdownText} thinkingSeconds={thinkingSeconds} />;

        if (isUser && entry.type === 'user') {
          return (
            <div key={entry.uuid} style={{ marginTop, background: 'var(--bg-card)', borderRadius: 10, padding: '10px 14px' }}>
              {content}
            </div>
          );
        }

        return (
          <div key={entry.uuid} style={{ marginTop }}>
            {content}
          </div>
        );
      })}
    </>
  );
}

/**
 * フロースタイル（モックアップ A2・既定）。バブルを廃止し、各ターンを全幅表示する。
 * ロールグルーピング（B1）: 連続する同一種別のエントリは1グループとして扱い、見出しと時刻は
 * グループにつき1回だけ描画する。
 */
export default function FlowEntry({ group, prevTimestamp }: StyleGroupProps) {
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

  if (group.type === 'system' || group.type === 'other') {
    let prevTs = prevTimestamp;
    return (
      <SystemOtherChip entryType={group.type}>
        {group.entries.map((entry) => {
          const thinkingSeconds = computeThinkingGapSeconds(prevTs, entry.timestamp);
          prevTs = entry.timestamp;
          return <BlockList key={entry.uuid} blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />;
        })}
      </SystemOtherChip>
    );
  }

  const isUser = group.type === 'user';

  return (
    <div style={{ margin: '14px 0' }}>
      <GroupHeading isUser={isUser} timeLabel={timeLabel} />
      <GroupEntries entries={group.entries} prevTimestamp={prevTimestamp} isUser={isUser} />
    </div>
  );
}
