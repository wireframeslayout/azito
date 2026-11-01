import { computeThinkingGapSeconds } from './transcriptFormat';
import type { TranscriptBlock, TranscriptEntry, TranscriptEntryType } from './transcriptTypes';

export interface ContextBlock {
  block: TranscriptBlock;
  key: string;
  entryKey: string;
  entryType: TranscriptEntryType;
  markdownText: boolean;
  thinkingSeconds: number | null;
}

/** 描画単位。連続ツール（2件以上）は isToolRun、それ以外は同一エントリ内のブロック列。 */
export interface BlockSegment {
  key: string;
  entryType: TranscriptEntryType;
  isToolRun: boolean;
  blocks: ContextBlock[];
}

function isToolBlock(block: TranscriptBlock): boolean {
  return block.kind === 'tool_use' || block.kind === 'tool_result';
}

export function groupToolBlocks(blocks: ContextBlock[]): ContextBlock[][] {
  const groups: ContextBlock[][] = [];
  for (const item of blocks) {
    const isTool = isToolBlock(item.block);
    const previous = groups[groups.length - 1];
    const previousBlock = previous?.[0].block;
    if (isTool && previousBlock && isToolBlock(previousBlock)) previous.push(item);
    else if (!isTool && previousBlock && !isToolBlock(previousBlock) && previous[0].entryKey === item.entryKey) previous.push(item);
    else groups.push([item]);
  }
  const merged: ContextBlock[][] = [];
  for (const group of groups) {
    const first = group[0];
    const isRun = group.length > 1 && group.some(({ block }) => block.kind === 'tool_use') && group.every(({ block }) => isToolBlock(block));
    const previous = merged[merged.length - 1];
    const previousIsRun = previous !== undefined && previous.length > 1 && previous.some(({ block }) => block.kind === 'tool_use') && previous.every(({ block }) => isToolBlock(block));
    if (!isRun && previous && !previousIsRun && previous[0].entryKey === first.entryKey) previous.push(...group);
    else merged.push([...group]);
  }
  return merged;
}

/** ロールグループ内のエントリをブロック単位に展開し、連続ツールを束ねた描画単位にする。 */
export function buildBlockSegments(entries: TranscriptEntry[], prevTimestamp: string | null): BlockSegment[] {
  let prevTs = prevTimestamp;
  const blocks = entries.flatMap((entry) => {
    const thinkingSeconds = computeThinkingGapSeconds(prevTs, entry.timestamp);
    prevTs = entry.timestamp;
    return entry.blocks.map((block, index): ContextBlock => ({
      block,
      key: `${entry.uuid}-${index}`,
      entryKey: entry.uuid,
      entryType: entry.type,
      markdownText: entry.type === 'assistant',
      thinkingSeconds,
    }));
  });
  return groupToolBlocks(blocks).map((group) => ({
    key: group[0].key,
    entryType: group[0].entryType,
    isToolRun: group.length > 1 && group.some(({ block }) => block.kind === 'tool_use') && group.every(({ block }) => isToolBlock(block)),
    blocks: group,
  }));
}
