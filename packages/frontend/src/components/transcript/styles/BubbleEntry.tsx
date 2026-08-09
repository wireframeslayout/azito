import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../../MarkdownRenderer';
import { CollapsibleBlock } from '../CollapsibleBlock';
import { computeThinkingGapSeconds, formatEntryTimestamp } from '../transcriptFormat';
import type { TranscriptBlock, TranscriptEntry } from '../transcriptTypes';
import { GroupHeading } from './GroupHeading';
import { SystemOtherChip } from './SystemOtherChip';
import { ThinkingChip } from './ThinkingChip';
import type { StyleGroupProps } from './types';

// モックアップ A1 指定値。既存トークンに 86% 幅に対応するものが無いため直接指定する。
const BUBBLE_MAX_WIDTH = '86%';

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

/** グループ内の各エントリを縦に連結して描画する（B1: ロールグルーピング）。gap は小さめ。 */
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
        const marginTop = i > 0 ? 4 : 0;

        if (entry.type === 'tool') {
          return (
            <div key={entry.uuid} style={{ marginTop, width: '100%' }}>
              <BlockList blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />
            </div>
          );
        }

        return (
          <div
            key={entry.uuid}
            style={{
              marginTop,
              padding: '10px 14px',
              borderRadius: isUser
                ? 'var(--radius-lg) var(--radius-lg) var(--space-1) var(--radius-lg)'
                : 'var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--space-1)',
              // モックアップ指定「accent の14%面」に最も近い既存トークンとして accent-a15 を使う。
              background: isUser ? 'var(--accent-a15)' : 'var(--bg-card)',
              minWidth: 0,
              maxWidth: '100%',
            }}
          >
            <BlockList blocks={entry.blocks} markdownText={!isUser} thinkingSeconds={thinkingSeconds} />
          </div>
        );
      })}
    </>
  );
}

/**
 * バブルスタイル（モックアップ A1）。user は右寄せ・accent 面、assistant は左寄せ・カード面。
 * 境界線は使わず、面色と角丸のみで発話者を区別する。
 * ロールグルーピング（B1）: 連続する同一種別のエントリは1グループとして扱い、見出しと時刻は
 * グループにつき1回だけ描画する。
 */
export default function BubbleEntry({ group, prevTimestamp }: StyleGroupProps) {
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
        <GroupHeading isUser={isUser} timeLabel={timeLabel} />
        <GroupEntries entries={group.entries} prevTimestamp={prevTimestamp} isUser={isUser} />
      </div>
    </div>
  );
}
