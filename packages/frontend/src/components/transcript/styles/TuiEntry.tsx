import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { computeThinkingGapSeconds, splitCodeBlocks } from '../transcriptFormat';
import type { TranscriptBlock } from '../transcriptTypes';
import { SystemOtherChip } from './SystemOtherChip';
import { ThinkingChip } from './ThinkingChip';
import type { StyleEntryProps } from './types';

const MONO_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace";
// 既存トークンに 12.5px はないため、直近の --font-md (13px) を使う（本スタイルは等幅ターミナル調のため
// このわずかな差は視認に影響しない）。
const TUI_FONT_SIZE = 'var(--font-md)';
const TOOL_RESULT_PREVIEW_LINES = 5;

function TuiText({ text }: { text: string }) {
  const segments = splitCodeBlocks(text);
  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
      {segments.map((seg, i) => seg.kind === 'code'
        ? (
          <pre
            key={i}
            style={{
              margin: '4px 0',
              padding: '8px 10px',
              background: 'var(--bg-hover)',
              borderRadius: 'var(--radius-sm)',
              overflowX: 'auto',
              fontSize: 'var(--font-sm)',
            }}
          >
            <code>{seg.text}</code>
          </pre>
        )
        : <span key={i}>{seg.text}</span>)}
    </div>
  );
}

function TuiToolResult({ block }: { block: Extract<TranscriptBlock, { kind: 'tool_result' }> }) {
  const { t } = useTranslation('transcript');
  const [expanded, setExpanded] = useState(false);
  const lines = block.text.split('\n');
  const isLong = lines.length > TOOL_RESULT_PREVIEW_LINES;
  const shown = expanded || !isLong ? lines : lines.slice(0, TOOL_RESULT_PREVIEW_LINES);
  const extra = lines.length - TOOL_RESULT_PREVIEW_LINES;

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
      <span aria-hidden="true" style={{ color: 'var(--text-dim)', flexShrink: 0 }}>⎿</span>
      <pre
        style={{
          margin: 0,
          color: 'var(--text-dim)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
          fontFamily: 'inherit',
          fontSize: 'inherit',
        }}
      >
        {shown.join('\n')}
        {!expanded && isLong && (
          <>
            {'\n'}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--accent)',
                fontSize: 'var(--font-xs)',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('conversation.moreLines', { count: extra })}
            </button>
          </>
        )}
        {block.truncated && `  ${t('conversation.blockTruncated')}`}
      </pre>
    </div>
  );
}

function EntryBlocks({ blocks, isUser, thinkingSeconds }: {
  blocks: TranscriptBlock[];
  isUser: boolean;
  thinkingSeconds: number | null;
}) {
  const { t } = useTranslation('transcript');
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'text':
            return isUser
              ? <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontWeight: 600 }}>{block.text}</div>
              : (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span aria-hidden="true" style={{ color: 'var(--success)', flexShrink: 0 }}>⏺</span>
                  <TuiText text={block.text} />
                </div>
              );
          case 'thinking':
            return <ThinkingChip key={i} text={block.text} seconds={thinkingSeconds} />;
          case 'tool_use': {
            const summary = block.input.length > 60 ? `${block.input.slice(0, 60)}…` : block.input;
            return (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: 'var(--text-dim)' }}>
                <span aria-hidden="true" style={{ color: 'var(--warning)', flexShrink: 0 }}>⏺</span>
                <span>
                  {t('conversation.toolUse', { name: block.name })}
                  {'('}{summary}{')'}
                  {block.truncated && ` ${t('conversation.blockTruncated')}`}
                </span>
              </div>
            );
          }
          case 'tool_result':
            return <TuiToolResult key={i} block={block} />;
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * TUI スタイル（モックアップ B）。既存ターミナルと同じ等幅フォントで、Claude Code CLI の
 * 出力そのものに近い見た目にする。テキストは簡略 markdown（改行・コードブロックのみ保持）。
 */
export default function TuiEntry({ entry, prevTimestamp }: StyleEntryProps) {
  const thinkingSeconds = computeThinkingGapSeconds(prevTimestamp, entry.timestamp);
  const isUser = entry.type === 'user';

  const body = (
    <div style={{ fontFamily: MONO_FONT, fontSize: TUI_FONT_SIZE, margin: '3px 0' }}>
      {isUser ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <span aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0, fontWeight: 700 }}>❯</span>
          <EntryBlocks blocks={entry.blocks} isUser thinkingSeconds={thinkingSeconds} />
        </div>
      ) : (
        <EntryBlocks blocks={entry.blocks} isUser={false} thinkingSeconds={thinkingSeconds} />
      )}
    </div>
  );

  if (entry.type === 'system' || entry.type === 'other') {
    return (
      <SystemOtherChip entry={entry}>
        <EntryBlocks blocks={entry.blocks} isUser={false} thinkingSeconds={thinkingSeconds} />
      </SystemOtherChip>
    );
  }

  return body;
}
