import { describe, it, expect } from 'vitest';
import { stripDirty, normalizeLegacyTabs, migrateTerminalTabs, type PersistedTab } from './useTabPersistence';
import type { Session } from '../pages/workspace/types';

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

// 5-B: legacy `terminal:<server>/<target>` ids are rewritten to the TerminalRef form once the
// sessions of the tab's server are known. The hook calls migrateTerminalTabs from
// migrateLegacyTerminalTabIds (wired in Workspace on every sessionData change), so the pure
// function is what decides "migrate now" vs "wait for data".
describe('migrateTerminalTabs — legacy terminal tab ids (stage 5-B)', () => {
  const sessions: Session[] = [{
    name: 'azito',
    windows: [
      { index: 1, name: 'win--abc', ref: JSON.stringify({ kind: 'tmux', workspace: 'azito', window: 'win--abc' }), windowId: 695, panes: [] },
      { index: 2, name: 'orphan', ref: JSON.stringify({ kind: 'tmux', workspace: 'azito', window: 'orphan' }), windowId: null, panes: [] },
    ],
  }] as unknown as Session[];

  it('rewrites a registered window to the windowId form and keeps the pane ordinal', () => {
    const tab = makeTab({ id: 'terminal:local/azito:win--abc.2', type: 'terminal', serverName: 'local', target: 'azito:win--abc.2' });
    const { tabs, changed } = migrateTerminalTabs([tab], new Map([['local', sessions]]));
    expect(changed).toBe(true);
    expect(tabs[0].id).toBe('terminal:local::w695.2');
    expect(tabs[0].terminalRef).toEqual({ kind: 'windowId', serverName: 'local', windowId: 695, pane: 2 });
  });

  it('falls back to the ref form for a live but unregistered window', () => {
    const tab = makeTab({ id: 'terminal:local/azito:orphan.1', type: 'terminal', serverName: 'local', target: 'azito:orphan.1' });
    const { tabs } = migrateTerminalTabs([tab], new Map([['local', sessions]]));
    expect(tabs[0].terminalRef).toEqual({ kind: 'ref', serverName: 'local', ref: JSON.stringify({ kind: 'tmux', workspace: 'azito', window: 'orphan' }), pane: 1 });
    expect(tabs[0].id.startsWith('terminal:local::ref:')).toBe(true);
  });

  it('leaves a tab untouched while its server\'s sessions are not fetched yet', () => {
    const tab = makeTab({ id: 'terminal:server007/azito:win--x.1', type: 'terminal', serverName: 'server007', target: 'azito:win--x.1' });
    const { tabs, changed } = migrateTerminalTabs([tab], new Map([['local', sessions]]));
    expect(changed).toBe(false);
    expect(tabs[0]).toBe(tab);
  });

  it('is a no-op for tabs that already carry a TerminalRef or are not terminals', () => {
    const done = makeTab({ id: 'terminal:local::w695.1', type: 'terminal', serverName: 'local', terminalRef: { kind: 'windowId', serverName: 'local', windowId: 695, pane: 1 } });
    const file = makeTab();
    const { tabs, changed } = migrateTerminalTabs([done, file], new Map([['local', sessions]]));
    expect(changed).toBe(false);
    expect(tabs[0]).toBe(done);
    expect(tabs[1]).toBe(file);
  });
});
