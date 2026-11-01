import type { TranscriptBlock } from './transcriptTypes';

export interface ContextBlock {
  block: TranscriptBlock;
  key: string;
  entryKey: string;
  markdownText: boolean;
  thinkingSeconds: number | null;
}

export function groupToolBlocks(blocks: ContextBlock[]): ContextBlock[][] {
  const groups: ContextBlock[][] = [];
  for (const item of blocks) {
    const isTool = item.block.kind === 'tool_use' || item.block.kind === 'tool_result';
    const previous = groups[groups.length - 1];
    const previousBlock = previous?.[0].block;
    if (isTool && previousBlock && (previousBlock.kind === 'tool_use' || previousBlock.kind === 'tool_result')) previous.push(item);
    else if (!isTool && previousBlock && previousBlock.kind !== 'tool_use' && previousBlock.kind !== 'tool_result' && previous[0].entryKey === item.entryKey) previous.push(item);
    else groups.push([item]);
  }
  const merged: ContextBlock[][] = [];
  for (const group of groups) {
    const first = group[0];
    const isRun = group.length > 1 && (first.block.kind === 'tool_use' || first.block.kind === 'tool_result');
    const previous = merged[merged.length - 1];
    const previousFirst = previous?.[0];
    const previousIsRun = previous && previous.length > 1 && previous.every(({ block }) => block.kind === 'tool_use' || block.kind === 'tool_result');
    if (!isRun && previous && !previousIsRun && previousFirst.entryKey === first.entryKey) previous.push(...group);
    else merged.push([...group]);
  }
  return merged;
}
