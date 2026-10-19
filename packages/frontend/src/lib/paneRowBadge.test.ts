import { describe, expect, it } from 'vitest';
import { paneRowBadge } from './paneRowBadge';

describe('paneRowBadge', () => {
  it('returns a tmux handle as is', () => {
    expect(paneRowBadge({ index: 0, handle: '%324' })).toBe('%324');
  });

  it('shortens a misao handle to its last 4 characters', () => {
    expect(paneRowBadge({ index: 0, handle: 'p_01J5ABC1234' })).toBe('#1234');
  });

  it('falls back to the index when there is no handle', () => {
    expect(paneRowBadge({ index: 2 })).toBe('%2');
  });

  it('does not show the deleted pane and keeps the survivors labelled by handle', () => {
    const before = [
      { index: 0, handle: '%316' },
      { index: 1, handle: '%324' },
      { index: 2, handle: '%323' },
    ];
    const after = before.filter((p) => p.handle !== '%324').map((p, index) => ({ ...p, index }));
    const badges = after.map(paneRowBadge);
    expect(badges).toEqual(['%316', '%323']);
    expect(badges).not.toContain('%324');
  });
});
