import { describe, expect, it } from 'vitest';
import { windowSnapshotSchema } from './windowSnapshotSchema';

describe('windowSnapshotSchema', () => {
  it('deduplicates ids and parses since and default lines', () => {
    const result = windowSnapshotSchema.parse({ ids: '2,1,2', since: '2:0,1:42' });
    expect(result.ids).toEqual([2, 1]);
    expect(result.lines).toBe(12);
    expect(result.since?.get(2)).toBe(0);
  });
  it.each([{ ids: '0' }, { ids: '1', lines: '61' }, { ids: '1', lines: '0' }, { ids: '1', since: '1:1,1:2' }, { ids: '1', since: '1:-1' }, { ids: '9007199254740992' }])('rejects invalid input %o', (query) => {
    expect(windowSnapshotSchema.safeParse(query).success).toBe(false);
  });
});
