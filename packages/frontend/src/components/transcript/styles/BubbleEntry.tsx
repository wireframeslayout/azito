import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../../MarkdownRenderer';
import { CollapsibleBlock } from '../CollapsibleBlock';
import { computeThinkingGapSeconds, formatEntryTimestamp } from '../transcriptFormat';
import type { TranscriptBlock } from '../transcriptTypes';
import { SystemOtherChip } from './SystemOtherChip';
import { ThinkingChip } from './ThinkingChip';
import type { StyleEntryProps } from './types';

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
                label={t('conversation.toolUse', { name: block.name })}
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
                label={block.isError ? t('conversation.toolResultError') : t('conversation.toolResult')}
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
 * バブルスタイル（モックアップ A1）。user は右寄せ・accent 面、assistant は左寄せ・カード面。
 * 境界線は使わず、面色と角丸のみで発話者を区別する。
 */
export default function BubbleEntry({ entry, prevTimestamp }: StyleEntryProps) {
  const { i18n } = useTranslation('transcript');
  const timeLabel = formatEntryTimestamp(entry.timestamp, i18n.language);
  const thinkingSeconds = computeThinkingGapSeconds(prevTimestamp, entry.timestamp);

  if (entry.type === 'tool') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '4px 0' }}>
        <div style={{ maxWidth: BUBBLE_MAX_WIDTH, minWidth: 0 }}>
          <BlockList blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />
        </div>
      </div>
    );
  }

  if (entry.type === 'system' || entry.type === 'other') {
    return (
      <SystemOtherChip entry={entry}>
        <BlockList blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />
      </SystemOtherChip>
    );
  }

  const isUser = entry.type === 'user';

  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', margin: '8px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', maxWidth: BUBBLE_MAX_WIDTH, minWidth: 0 }}>
        <div
          style={{
            padding: '10px 14px',
            borderRadius: isUser ? 'var(--radius-lg) var(--radius-lg) var(--space-1) var(--radius-lg)' : 'var(--radius-lg) var(--radius-lg) var(--radius-lg) var(--space-1)',
            // モックアップ指定「accent の14%面」に最も近い既存トークンとして accent-a15 を使う。
            background: isUser ? 'var(--accent-a15)' : 'var(--bg-card)',
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          <BlockList blocks={entry.blocks} markdownText={!isUser} thinkingSeconds={thinkingSeconds} />
        </div>
        {timeLabel && (
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', marginTop: 3, padding: '0 4px' }}>
            {timeLabel}
          </span>
        )}
      </div>
    </div>
  );
}
