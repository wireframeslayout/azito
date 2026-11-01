import { describe, expect, it } from 'vitest';
import { groupToolBlocks, type ContextBlock } from './groupToolBlocks';

function item(block: ContextBlock['block'], key: string, entryKey = 'a'): ContextBlock {
  return { block, key, entryKey, markdownText: true, thinkingSeconds: null };
}
const use = { kind: 'tool_use', name: 'Bash', input: '', truncated: false } as const;
const result = { kind: 'tool_result', text: '', truncated: false, isError: true } as const;
const text = { kind: 'text', text: 'hello' } as const;

describe('groupToolBlocks', () => {
  it('groups consecutive tools across entries and stops at text', () => {
    expect(groupToolBlocks([])).toEqual([]);
    expect(groupToolBlocks([item(use, '1')])).toHaveLength(1);
    const groups = groupToolBlocks([item(use, '1'), item(result, '2', 'b'), item(text, '3', 'b'), item(use, '4', 'b')]);
    expect(groups.map((group) => group.length)).toEqual([2, 1, 1]);
    expect(groups[0][1].block).toEqual(result);
  });
});
