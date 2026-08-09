import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../../MarkdownRenderer';
import { CollapsibleBlock } from '../CollapsibleBlock';
import { computeThinkingGapSeconds, formatEntryTimestamp } from '../transcriptFormat';
import type { TranscriptBlock } from '../transcriptTypes';
import { SystemOtherChip } from './SystemOtherChip';
import { ThinkingChip } from './ThinkingChip';
import type { StyleEntryProps } from './types';

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

function RoleRow({ isUser, timeLabel }: { isUser: boolean; timeLabel: string }) {
  const { t } = useTranslation('transcript');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          flexShrink: 0,
          background: isUser ? 'var(--accent)' : 'var(--text-dim)',
        }}
      />
      <span
        style={{
          fontSize: 'var(--font-2xs)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          color: 'var(--text-dim)',
        }}
      >
        {isUser ? t('styleSwitcher.flow.userLabel') : t('styleSwitcher.flow.assistantLabel')}
      </span>
      <span style={{ flex: 1 }} />
      {timeLabel && (
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>{timeLabel}</span>
      )}
    </div>
  );
}

/**
 * フロースタイル（モックアップ A2・既定）。バブルを廃止し、各ターンを全幅表示する。
 * user ターンのみカード面を敷き、assistant はロール行の下にそのまま続ける。
 * tool/thinking はロール行を持たない独立エントリのため、インデントなしで直下に続く。
 */
export default function FlowEntry({ entry, prevTimestamp }: StyleEntryProps) {
  const { i18n } = useTranslation('transcript');
  const timeLabel = formatEntryTimestamp(entry.timestamp, i18n.language);
  const thinkingSeconds = computeThinkingGapSeconds(prevTimestamp, entry.timestamp);

  if (entry.type === 'tool') {
    return (
      <div style={{ margin: '2px 0 14px' }}>
        <BlockList blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />
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
    <div style={{ margin: '14px 0' }}>
      <RoleRow isUser={isUser} timeLabel={timeLabel} />
      <div
        style={isUser
          ? { background: 'var(--bg-card)', borderRadius: 10, padding: '10px 14px' }
          : undefined}
      >
        <BlockList blocks={entry.blocks} markdownText={!isUser} thinkingSeconds={thinkingSeconds} />
      </div>
    </div>
  );
}
