import type { TranscriptEntry } from './transcriptTypes';

/** この秒数より古い最終エントリはライブ状態を表示しない（応答が止まっているとみなす）。 */
const LIVE_STATUS_MAX_AGE_SECONDS = 90;

export type LiveStatus =
  | { kind: 'thinking' }
  | { kind: 'tool'; toolName: string };

/**
 * 直近エントリから「いま起きていること」のライブ状態を推定する純関数（会話ビュー末尾のライブ
 * インジケータ用）。
 *
 * - 最後のエントリの timestamp が LIVE_STATUS_MAX_AGE_SECONDS 秒より古い、または timestamp が
 *   欠落している場合は null（非表示）。
 * - 最後のエントリが user → thinking（エージェントが応答を考え始めている）。
 * - 最後のエントリが tool（tool_result）→ thinking（結果を受けて続行中）。
 * - 最後のエントリが assistant で最後のブロックが tool_use → tool（ツール名付き）。
 * - 最後のエントリが assistant で最後のブロックが text/thinking → null（応答完了とみなす）。
 * - system / other はこの機能の対象外として null を返す。
 */
export function deriveLiveStatus(entries: TranscriptEntry[], now: number): LiveStatus | null {
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  if (!last.timestamp) return null;

  const lastMs = new Date(last.timestamp).getTime();
  if (!Number.isFinite(lastMs)) return null;

  const elapsedSeconds = (now - lastMs) / 1000;
  if (elapsedSeconds > LIVE_STATUS_MAX_AGE_SECONDS) return null;

  switch (last.type) {
    case 'user':
      return { kind: 'thinking' };
    case 'tool':
      return { kind: 'thinking' };
    case 'assistant': {
      const lastBlock = last.blocks[last.blocks.length - 1];
      if (lastBlock?.kind === 'tool_use') return { kind: 'tool', toolName: lastBlock.name };
      return null;
    }
    default:
      return null;
  }
}
