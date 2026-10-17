import { describe, it, expect } from 'vitest';
import { decideOlderPageContinuation, MAX_CONSECUTIVE_EMPTY_OLDER_PAGES } from './olderPaging';

describe('decideOlderPageContinuation', () => {
  it('does not continue by itself after a page that had entries (the entries change drives the normal continuation)', () => {
    expect(decideOlderPageContinuation(1000, { entryCount: 3, prevOffset: 400, hasOlder: true }, 2)).toEqual({ continuePaging: false, emptyStreak: 0 });
  });

  it('continues past an empty page whose offset moved back while older data remains', () => {
    expect(decideOlderPageContinuation(1000, { entryCount: 0, prevOffset: 500, hasOlder: true }, 0)).toEqual({ continuePaging: true, emptyStreak: 1 });
  });

  it('stops when there is nothing older', () => {
    expect(decideOlderPageContinuation(1000, { entryCount: 0, prevOffset: 0, hasOlder: false }, 0).continuePaging).toBe(false);
  });

  it('stops when the offset did not move back (no progress, would loop forever)', () => {
    expect(decideOlderPageContinuation(1000, { entryCount: 0, prevOffset: 1000, hasOlder: true }, 0).continuePaging).toBe(false);
    expect(decideOlderPageContinuation(1000, { entryCount: 0, prevOffset: 1200, hasOlder: true }, 0).continuePaging).toBe(false);
  });

  it('allows up to the cap of consecutive empty pages, then stops until the next user action', () => {
    let streak = 0;
    let continued = 0;
    let offset = 100_000;
    for (let i = 0; i < 20; i++) {
      const next = offset - 1000;
      const outcome = decideOlderPageContinuation(offset, { entryCount: 0, prevOffset: next, hasOlder: true }, streak);
      streak = outcome.emptyStreak;
      offset = next;
      if (!outcome.continuePaging) break;
      continued++;
    }
    expect(continued).toBe(MAX_CONSECUTIVE_EMPTY_OLDER_PAGES);
  });
});
