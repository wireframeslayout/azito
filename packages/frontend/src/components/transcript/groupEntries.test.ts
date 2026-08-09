import { describe, expect, it } from 'vitest';
import { groupEntries } from './groupEntries';
import type { TranscriptEntry } from './transcriptTypes';

function entry(uuid: string, type: TranscriptEntry['type']): TranscriptEntry {
  return { uuid, type, timestamp: null, blocks: [] };
}

describe('groupEntries', () => {
  it('returns an empty array for an empty input', () => {
    expect(groupEntries([])).toEqual([]);
  });

  it('merges consecutive assistant entries into one group', () => {
    const entries = [entry('1', 'assistant'), entry('2', 'assistant')];
    const groups = groupEntries(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ type: 'assistant', entries });
  });

  it('absorbs tool entries that directly follow an assistant entry into the assistant group', () => {
    const a = entry('1', 'assistant');
    const t1 = entry('2', 'tool');
    const t2 = entry('3', 'tool');
    const groups = groupEntries([a, t1, t2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ type: 'assistant', entries: [a, t1, t2] });
  });

  it('splits groups on a user entry', () => {
    const a1 = entry('1', 'assistant');
    const u = entry('2', 'user');
    const a2 = entry('3', 'assistant');
    const groups = groupEntries([a1, u, a2]);
    expect(groups).toEqual([
      { type: 'assistant', entries: [a1] },
      { type: 'user', entries: [u] },
      { type: 'assistant', entries: [a2] },
    ]);
  });

  it('starts a new tool group when a tool entry does not directly follow an assistant entry', () => {
    const u = entry('1', 'user');
    const tl = entry('2', 'tool');
    const groups = groupEntries([u, tl]);
    expect(groups).toEqual([
      { type: 'user', entries: [u] },
      { type: 'tool', entries: [tl] },
    ]);
  });

  it('merges consecutive system and other entries', () => {
    const s1 = entry('1', 'system');
    const s2 = entry('2', 'system');
    const o1 = entry('3', 'other');
    const groups = groupEntries([s1, s2, o1]);
    expect(groups).toEqual([
      { type: 'system', entries: [s1, s2] },
      { type: 'other', entries: [o1] },
    ]);
  });
});
