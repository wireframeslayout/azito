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
  return groups;
}
