import type { TranscriptBlock, TranscriptEntry } from '../transcriptTypes';

const MONO_FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace";

function isTextBlock(block: TranscriptBlock): block is Extract<TranscriptBlock, { kind: 'text' }> {
  return block.kind === 'text';
}

/**
 * ローカルスラッシュコマンド実行（例: /model）の終端行。全表示スタイル共通コンポーネント
 * （InterruptedRow と同様の位置付け）。ユーザー発話バブルとしては表示せず、コマンド名を
 * チップ風に、出力（あれば）を控えめな複数行テキストとして下に添える。
 * commandName が無い場合（隣接しない単独 stdout/stderr）はチップを出さず出力のみ表示する。
 */
export function CommandRow({ entry }: { entry: TranscriptEntry }) {
  const outputText = entry.blocks.filter(isTextBlock).map((block) => block.text).join('\n');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, margin: '10px 0' }}>
      {entry.commandName && (
        <span
          style={{
            display: 'inline-flex',
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-hover)',
            color: 'var(--text-dim)',
            fontFamily: MONO_FONT,
            fontSize: 'var(--font-xs)',
          }}
        >
          {entry.commandName}
        </span>
      )}
      {outputText && (
        <div
          style={{
            paddingLeft: entry.commandName ? 4 : 0,
            fontSize: 'var(--font-xs)',
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {outputText}
        </div>
      )}
    </div>
  );
}
