import { describe, it, expect } from 'vitest';
import { createRequestGuard, dedupeSelectableUrls } from './repoDiscoveryDialogLogic';

// Issue #19 third-party review round 2:
// - Important finding 2: a stale, out-of-order discovery response must
//   never overwrite the result of a later, still-current request.
// - Minor finding 4: "select all" must be computed against the
//   deduplicated set of selectable URLs, not the raw remote count.

describe('createRequestGuard', () => {
  it('reports only the most recently started request as current', () => {
    const guard = createRequestGuard();
    const first = guard.start();
    const second = guard.start();

    expect(first).not.toBe(second);
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('does not let a late-arriving earlier request overwrite a later one', () => {
    // Simulates: request A (server X) starts, then request B (server Y)
    // starts before A resolves, then A's response finally arrives.
    const guard = createRequestGuard();
    const requestA = guard.start();
    const requestB = guard.start();

    // B resolves first (fast server).
    const applyB = guard.isCurrent(requestB);
    expect(applyB).toBe(true);

    // A resolves late (slow server) — must be ignored, not applied.
    const applyA = guard.isCurrent(requestA);
    expect(applyA).toBe(false);
  });

  it('accepts a single request as current when nothing else has started', () => {
    const guard = createRequestGuard();
    const only = guard.start();
    expect(guard.isCurrent(only)).toBe(true);
  });
});

describe('dedupeSelectableUrls', () => {
  it('deduplicates the same remote URL appearing across multiple repos/worktrees', () => {
    const urls = dedupeSelectableUrls([
      { url: 'https://github.com/acme/widgets.git', alreadyRegistered: false },
      { url: 'https://github.com/acme/widgets.git', alreadyRegistered: false },
      { url: 'https://github.com/acme/gadgets.git', alreadyRegistered: false },
    ]);
    expect(urls).toHaveLength(2);
    expect(new Set(urls)).toEqual(new Set(['https://github.com/acme/widgets.git', 'https://github.com/acme/gadgets.git']));
  });

  it('excludes already-registered remotes from the selectable set', () => {
    const urls = dedupeSelectableUrls([
      { url: 'https://github.com/acme/widgets.git', alreadyRegistered: true },
      { url: 'https://github.com/acme/gadgets.git', alreadyRegistered: false },
    ]);
    expect(urls).toEqual(['https://github.com/acme/gadgets.git']);
  });

  it('yields a length that lets "select all" become checked when every duplicate is selected', () => {
    const remotes = [
      { url: 'https://github.com/acme/widgets.git', alreadyRegistered: false },
      { url: 'https://github.com/acme/widgets.git', alreadyRegistered: false },
      { url: 'https://github.com/acme/widgets.git', alreadyRegistered: false },
    ];
    const selectableUrls = dedupeSelectableUrls(remotes);
    const selected = new Set(selectableUrls); // "select all" clicked

    // Previously this comparison used remotes.length (3, raw occurrences)
    // against a URL-keyed Set (size 1), so it could never be true.
    expect(selected.size).toBe(selectableUrls.length);
    expect(selectableUrls.length).toBe(1);
  });
});
