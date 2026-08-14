import { useTranslation } from 'react-i18next';
import MarkdownRenderer from '../../MarkdownRenderer';
import { computeThinkingGapSeconds, taskNotificationSummary } from '../transcriptFormat';
import type { TranscriptBlock, TranscriptEntry } from '../transcriptTypes';
import { CommandRow } from './CommandRow';
import { InteractionCard } from './InteractionCard';
import { InterruptedRow } from './InterruptedRow';
import { SystemEntryText } from './SystemEntryText';
import { SystemOtherChip } from './SystemOtherChip';
import { ThinkingChip } from './ThinkingChip';
import type { StyleGroupProps } from './types';

const MONO_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace";
// グループ内2行目以降（先頭以外）は 22px グリフ列 + 8px gap 分だけインデントして、
// 先頭行の内容列と揃える（B1: rail はグリフ列を先頭行のみに表示）。
const CONTINUATION_INDENT = 30;

function RailRow({ glyph, glyphColor, highlight, children }: {
  glyph: string;
  glyphColor: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '22px 1fr',
        gap: 8,
        alignItems: 'start',
        padding: highlight ? '4px 8px' : '4px 2px',
        borderRadius: highlight ? 'var(--radius-md)' : 0,
        // モックアップ指定「accent の7%面」に最も近い既存トークンとして accent-a08 を使う。
        background: highlight ? 'var(--accent-a08)' : 'transparent',
        marginBottom: 6,
      }}
    >
      <span aria-hidden="true" style={{ textAlign: 'center', color: glyphColor, fontFamily: MONO_FONT, lineHeight: 1.6 }}>
        {glyph}
      </span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function RailToolUse({ block }: { block: Extract<TranscriptBlock, { kind: 'tool_use' }> }) {
  const { t } = useTranslation('transcript');
  const summary = block.input.length > 60 ? `${block.input.slice(0, 60)}…` : block.input;
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', listStyle: 'none' }}>
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>{block.name}</span>
        {' · '}
        <span style={{ fontFamily: MONO_FONT }}>{summary}</span>
        {block.truncated && <span> {t('conversation.blockTruncated')}</span>}
      </summary>
      <div
        style={{
          marginTop: 4,
          padding: '6px 8px',
          fontFamily: MONO_FONT,
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
        }}
      >
        {block.input}
      </div>
    </details>
  );
}

function RailToolResult({ block }: { block: Extract<TranscriptBlock, { kind: 'tool_result' }> }) {
  const { t } = useTranslation('transcript');
  const firstLine = block.text.split('\n', 1)[0] ?? '';
  const summary = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  const color = block.isError ? 'var(--danger)' : 'var(--success)';
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 'var(--font-sm)', listStyle: 'none' }}>
        <span aria-hidden="true" style={{ color, fontWeight: 600 }}>{block.isError ? '✗' : '✓'}</span>
        {' '}
        <span style={{ color: 'var(--text-dim)', fontFamily: MONO_FONT }}>
          {summary || t('conversation.toolResult')}
        </span>
        {block.truncated && <span style={{ color: 'var(--text-dim)' }}> {t('conversation.blockTruncated')}</span>}
      </summary>
      <div
        style={{
          marginTop: 4,
          padding: '6px 8px',
          fontFamily: MONO_FONT,
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
        }}
      >
        {block.text}
      </div>
    </details>
  );
}

function EntryBlocks({ blocks, markdownText, thinkingSeconds }: {
  blocks: TranscriptBlock[];
  markdownText: boolean;
  thinkingSeconds: number | null;
}) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'text':
            return markdownText
              ? <MarkdownRenderer key={i} content={block.text} style={{ fontSize: 'var(--font-base)' }} />
              : (
                <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--font-base)', lineHeight: 1.6 }}>
                  {block.text}
                </div>
              );
          case 'thinking':
            return <ThinkingChip key={i} text={block.text} seconds={thinkingSeconds} />;
          case 'tool_use':
            return <RailToolUse key={i} block={block} />;
          case 'tool_result':
            return <RailToolResult key={i} block={block} />;
          default:
            return null;
        }
      })}
    </>
  );
}

/** system/other グループのブロックを連結して描画する。task-notification 整形エントリは専用文言に差し替える。 */
function GroupBlocks({ entries, prevTimestamp }: { entries: TranscriptEntry[]; prevTimestamp: string | null }) {
  let prevTs = prevTimestamp;
  return (
    <>
      {entries.map((entry) => {
        const thinkingSeconds = computeThinkingGapSeconds(prevTs, entry.timestamp);
        prevTs = entry.timestamp;
        const notification = taskNotificationSummary(entry);
        if (notification !== null) return <SystemEntryText key={entry.uuid} entry={entry} />;
        return <EntryBlocks key={entry.uuid} blocks={entry.blocks} markdownText={false} thinkingSeconds={thinkingSeconds} />;
      })}
    </>
  );
}

/**
 * ログスタイル（モックアップ A3）。1カラムのログ表示で、行頭グリフで発話者/種別を示す。
 * user 行のみ面を敷き、tool は1行サマリ+タップ展開にして密度を高くする。
 * ロールグルーピング（B1）: グリフ列（行頭記号）はグループ先頭行のみに表示し、以降のエントリは
 * インデントのみで続ける。
 */
export default function RailEntry({ group, prevTimestamp }: StyleGroupProps) {
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
    return (
      <SystemOtherChip entryType={group.type}>
        <GroupBlocks entries={group.entries} prevTimestamp={prevTimestamp} />
      </SystemOtherChip>
    );
  }

  let prevTs = prevTimestamp;

  return (
    <>
      {group.entries.map((entry, i) => {
        const thinkingSeconds = computeThinkingGapSeconds(prevTs, entry.timestamp);
        prevTs = entry.timestamp;
        const markdownText = entry.type === 'assistant';
        const content = <EntryBlocks blocks={entry.blocks} markdownText={markdownText} thinkingSeconds={thinkingSeconds} />;

        if (i === 0) {
          const isUser = entry.type === 'user';
          const glyph = entry.type === 'tool' ? '⚙' : isUser ? '❯' : '●';
          const glyphColor = entry.type === 'tool' ? 'var(--warning)' : isUser ? 'var(--accent)' : 'var(--text-dim)';
          return (
            <RailRow key={entry.uuid} glyph={glyph} glyphColor={glyphColor} highlight={isUser}>
              {content}
            </RailRow>
          );
        }

        return (
          <div key={entry.uuid} style={{ marginLeft: CONTINUATION_INDENT, marginBottom: 6 }}>
            {content}
          </div>
        );
      })}
    </>
  );
}
