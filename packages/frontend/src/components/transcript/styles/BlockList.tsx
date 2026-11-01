import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../../MarkdownRenderer';
import { CollapsibleBlock } from '../CollapsibleBlock';
import type { TranscriptBlock } from '../transcriptTypes';
import { ThinkingChip } from './ThinkingChip';

function TextBlock({ text, markdown }: { text: string; markdown: boolean }) {
  if (markdown) {
    return <MarkdownRenderer content={text}  />;
  }
  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--font-base)', lineHeight: 1.8, fontFamily: 'var(--font-prose)' }}>
      {text}
    </div>
  );
}

export function BlockList({ blocks, markdownText, thinkingSeconds }: {
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

