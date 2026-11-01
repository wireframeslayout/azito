import { describe, expect, it } from 'vitest';
import { buildBlockSegments, groupToolBlocks, type ContextBlock } from './groupToolBlocks';
import type { TranscriptEntry } from './transcriptTypes';

function item(block: ContextBlock['block'], key: string, entryKey = 'a'): ContextBlock {
  return { block, key, entryKey, entryType: 'assistant', markdownText: true, thinkingSeconds: null };
}
const use = { kind: 'tool_use', name: 'Bash', input: '', truncated: false } as const;
const result = { kind: 'tool_result', text: '', truncated: false, isError: true } as const;
const text = { kind: 'text', text: 'hello' } as const;

describe('groupToolBlocks', () => {
  it('groups consecutive tools across entries and stops at text', () => {
    expect(groupToolBlocks([])).toEqual([]);
    expect(groupToolBlocks([item(use, '1')])).toHaveLength(1);
    const groups = groupToolBlocks([item(use, '1'), item(result, '2', 'b'), item(text, '3', 'b'), item(use, '4', 'b')]);
    expect(groups.map((group) => group.length)).toEqual([2, 2]);
    expect(groups[0][1].block).toEqual(result);
    expect(groups[1].map(({ block }) => block.kind)).toEqual(['text', 'tool_use']);
  });
  it('keeps a single tool with surrounding content from the same entry', () => {
    const groups = groupToolBlocks([item(text, '1'), item(use, '2'), item(text, '3')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map(({ block }) => block.kind)).toEqual(['text', 'tool_use', 'text']);
  });
  it('builds segments marking tool runs, entry types and per-entry thinking gaps', () => {
    const entries: TranscriptEntry[] = [
      { uuid: 'a', type: 'assistant', timestamp: '2026-08-10T09:00:00Z', blocks: [text, use] },
      { uuid: 't', type: 'tool', timestamp: '2026-08-10T09:00:05Z', blocks: [result] },
      { uuid: 'b', type: 'assistant', timestamp: '2026-08-10T09:00:10Z', blocks: [text] },
    ];
    const segments = buildBlockSegments(entries, '2026-08-10T08:59:58Z');
    expect(segments.map(({ key, entryType, isToolRun }) => ({ key, entryType, isToolRun }))).toEqual([
      { key: 'a-0', entryType: 'assistant', isToolRun: false },
      { key: 'a-1', entryType: 'assistant', isToolRun: true },
      { key: 'b-0', entryType: 'assistant', isToolRun: false },
    ]);
    expect(segments[1].blocks.map(({ entryType, markdownText }) => ({ entryType, markdownText }))).toEqual([
      { entryType: 'assistant', markdownText: true },
      { entryType: 'tool', markdownText: false },
    ]);
    expect(segments[0].blocks[0].thinkingSeconds).toBe(2);
  });
});
