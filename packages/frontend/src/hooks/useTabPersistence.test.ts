import { describe, it, expect } from 'vitest';
import { stripDirty, normalizeLegacyTabs, type PersistedTab } from './useTabPersistence';

// useTabPersistence itself can't be unit-tested here (it's a React hook, and this
// project's vitest config runs in a plain 'node' environment with no jsdom or
// @testing-library/react — see paneLayoutTree.test.ts for the same precedent), so
// these tests exercise the pure hydration/normalization logic the hook relies on
// directly.

function makeTab(overrides: Partial<PersistedTab> = {}): PersistedTab {
  return { id: 'file:local:/tmp/a.ts', type: 'file', label: 'a.ts', ...overrides };
}

describe('stripDirty', () => {
  it('removes the dirty field when present', () => {
    const tab = makeTab({ dirty: true });
    const result = stripDirty(tab);
    expect('dirty' in result).toBe(false);
    expect(result).toEqual(makeTab());
  });

  it('returns the same object reference when dirty is absent (no unnecessary allocation)', () => {
    const tab = makeTab();
    expect(stripDirty(tab)).toBe(tab);
  });

  it('strips dirty: false the same as dirty: true', () => {
    const tab = makeTab({ dirty: false });
    expect('dirty' in stripDirty(tab)).toBe(false);
  });
});

// Review Minor 4: `dirty` used to be serialized to localStorage verbatim despite its
// field comment claiming otherwise, so a reload could resurrect a stale "unsaved
// changes" flag from a previous session and trigger false close/beforeunload
// warnings. normalizeLegacyTabs runs on every hydration path (both the direct
// localStorage read and the legacy per-project migration path), so asserting it
// strips `dirty` covers the actual bug regardless of which path a given user's
// stored data takes.
describe('normalizeLegacyTabs — dirty flag hydration (Issue #27 review Minor 4)', () => {
  it('strips a dirty flag left over from a previous session', () => {
    const persisted: PersistedTab[] = [makeTab({ dirty: true })];
    const [result] = normalizeLegacyTabs(persisted);
    expect(result.dirty).toBeUndefined();
    expect('dirty' in result).toBe(false);
  });

  it('leaves other fields untouched while stripping dirty', () => {
    const persisted: PersistedTab[] = [
      makeTab({ dirty: true, pinned: true, filePath: '/tmp/a.ts', line: 42 }),
    ];
    const [result] = normalizeLegacyTabs(persisted);
    expect(result).toEqual(makeTab({ pinned: true, filePath: '/tmp/a.ts', line: 42 }));
  });

  it('is a no-op for tabs that never carried a dirty flag', () => {
    const persisted: PersistedTab[] = [makeTab()];
    expect(normalizeLegacyTabs(persisted)).toEqual(persisted);
  });
});
