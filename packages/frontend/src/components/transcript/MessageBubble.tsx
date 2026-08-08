import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../MarkdownRenderer';
import { CollapsibleBlock } from './CollapsibleBlock';
import { formatEntryTimestamp } from './transcriptFormat';
import type { TranscriptBlock, TranscriptEntry } from './transcriptTypes';

interface MessageBubbleProps {
  entry: TranscriptEntry;
}

const BUBBLE_MAX_WIDTH = '85%';

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

function BlockList({ blocks, markdownText }: { blocks: TranscriptBlock[]; markdownText: boolean }) {
  const { t } = useTranslation('transcript');

  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'text':
            return <TextBlock key={i} text={block.text} markdown={markdownText} />;
          case 'thinking':
            return (
              <CollapsibleBlock key={i} icon="chip" label={t('conversation.thinking')}>
                {block.text}
              </CollapsibleBlock>
            );
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

export default function MessageBubble({ entry }: MessageBubbleProps) {
  const { t, i18n } = useTranslation('transcript');
  const timeLabel = formatEntryTimestamp(entry.timestamp, i18n.language);

  if (entry.type === 'tool') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '4px 0' }}>
        <div style={{ maxWidth: BUBBLE_MAX_WIDTH, minWidth: 0 }}>
          <BlockList blocks={entry.blocks} markdownText={false} />
        </div>
      </div>
    );
  }

  if (entry.type === 'system' || entry.type === 'other') {
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
            {entry.type === 'system' ? t('conversation.system') : t('conversation.other')}
          </span>
          <BlockList blocks={entry.blocks} markdownText={false} />
        </div>
      </div>
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
            background: isUser ? 'var(--accent-a15)' : 'var(--bg-card)',
            border: `1px solid ${isUser ? 'var(--accent-a35)' : 'var(--border)'}`,
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          <BlockList blocks={entry.blocks} markdownText={!isUser} />
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
