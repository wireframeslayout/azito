import { describe, it, expect } from 'vitest';
import { applyRetargetTab, applyRetargetTabs, findWindowTerminalTabs } from './retargetTab';
import { retargetedTerminalRef, resolveRespawnedPane, terminalTabId, isValidTerminalRef, type TerminalRef } from './terminalRef';
import { normalizeLegacyTabs, type PersistedTab } from '../hooks/useTabPersistence';
import type { Session } from '../pages/workspace/types';

const REF = '{"kind":"tmux","workspace":"azito","window":"win--a"}';
const refTab = (pane = 1): PersistedTab => {
  const terminalRef: TerminalRef = { kind: 'ref', serverName: 'local', ref: REF, pane };
  return { id: terminalTabId(terminalRef), type: 'terminal', label: 'x', serverName: 'local', terminalRef };
};
const winTab = (windowId: number, pane = 1): PersistedTab => {
  const terminalRef: TerminalRef = { kind: 'windowId', serverName: 'local', windowId, pane };
  return { id: terminalTabId(terminalRef), type: 'terminal', label: 'x', serverName: 'local', terminalRef };
};
const sessions = (windowId: number, paneCount: number, ref = REF): Session[] => [{
  name: 's',
  windows: [{ index: 0, name: 'w', ref, windowId, panes: Array.from({ length: paneCount }, (_, i) => ({ index: i, title: '', command: '', width: 1, height: 1, active: i === 0 })) }],
}];

describe('applyRetargetTab', () => {
  it('replaces id, terminalRef and the active tab id', () => {
    const old = refTab();
    const newRef: TerminalRef = { kind: 'windowId', serverName: 'local', windowId: 9, pane: 1 };
    const r = applyRetargetTab({ tabs: [old], activeTabId: old.id }, old.id, newRef);
    expect(r.tabs).toHaveLength(1);
    expect(r.tabs[0]).toMatchObject({ id: 'terminal:local::w9.1', terminalRef: newRef, target: 'w9' });
    expect(r.activeTabId).toBe('terminal:local::w9.1');
  });

  it('keeps one tab when the target id already exists, reconnecting it and activating it', () => {
    const old = refTab();
    const existing = winTab(9);
    const r = applyRetargetTab({ tabs: [old, existing], activeTabId: old.id }, old.id, existing.terminalRef!);
    expect(r.tabs.map((t) => t.id)).toEqual([existing.id]);
    expect(r.tabs[0].reconnectKey).toBe(1);
    expect(r.activeTabId).toBe(existing.id);
  });

  it('leaves the active tab alone when another tab was active', () => {
    const old = refTab();
    const other = winTab(3);
    const r = applyRetargetTab({ tabs: [old, other], activeTabId: other.id }, old.id, winTab(9).terminalRef!);
    expect(r.activeTabId).toBe(other.id);
  });
});

describe('retarget pane resolution', () => {
  it('keeps the old pane when the window still has it', () => {
    expect(resolveRespawnedPane(3, sessions(9, 3), 9)).toBe(3);
  });
  it('falls back to pane 1 when the respawned window has fewer panes', () => {
    expect(retargetedTerminalRef(winTab(7, 3).id, 'local', 7, sessions(7, 1))).toMatchObject({ windowId: 7, pane: 1 });
  });
  it('falls back to pane 1 when the window is not listed', () => {
    expect(resolveRespawnedPane(2, sessions(1, 4), 9)).toBe(1);
    expect(resolveRespawnedPane(2, undefined, 9)).toBe(1);
  });
});

describe('findWindowTerminalTabs', () => {
  it('finds windowId tabs on every pane, and ref-form tabs through the sessions listing', () => {
    const a = winTab(9, 1);
    const b = winTab(9, 2);
    const c = refTab(3);
    expect(findWindowTerminalTabs([winTab(1), a, b, c], 'local', 9, sessions(9, 3))).toEqual([a, b, c]);
    expect(findWindowTerminalTabs([c], 'local', 9, undefined)).toEqual([]);
  });
});

describe('applyRetargetTabs', () => {
  it('retargets every pane tab of the window, resolving each pane against the new sessions', () => {
    const p1 = refTab(1);
    const p3 = refTab(3);
    const r = applyRetargetTabs({ tabs: [p1, p3], activeTabId: p3.id }, [p1.id, p3.id], 'local', 9, sessions(9, 2));
    expect(r.tabs.map((t) => t.id)).toEqual(['terminal:local::w9.1']);
    expect(r.moves).toEqual([{ oldId: p1.id, newId: 'terminal:local::w9.1' }, { oldId: p3.id, newId: 'terminal:local::w9.1' }]);
    expect(r.activeTabId).toBe('terminal:local::w9.1');
  });

  it('only reconnects a windowId tab whose pane still exists', () => {
    const t = winTab(9, 2);
    const r = applyRetargetTabs({ tabs: [t], activeTabId: t.id }, [t.id], 'local', 9, sessions(9, 2));
    expect(r.tabs[0]).toMatchObject({ id: t.id, reconnectKey: 1 });
    expect(r.moves).toEqual([]);
  });

  it('moves a windowId tab to pane 1 when its pane no longer exists', () => {
    const t = winTab(9, 3);
    const r = applyRetargetTabs({ tabs: [t], activeTabId: t.id }, [t.id], 'local', 9, sessions(9, 1));
    expect(r.tabs[0].id).toBe('terminal:local::w9.1');
    expect(r.moves).toEqual([{ oldId: t.id, newId: 'terminal:local::w9.1' }]);
  });
});

describe('persisted tabs broken by the raw-target retarget bug', () => {
  it('treats a non-MuxRef ref as invalid', () => {
    expect(isValidTerminalRef({ kind: 'ref', serverName: 'local', ref: 'azito:win', pane: 1 })).toBe(false);
  });
  it('rebuilds broken tabs in legacy form so sessions resolve them (tmux and misao targets alike)', () => {
    const mk = (target: string): PersistedTab => ({ id: `terminal:local::ref:${encodeURIComponent(target)}.2`, type: 'terminal', label: target, serverName: 'local', target, terminalRef: { kind: 'ref', serverName: 'local', ref: target, pane: 2 } });
    const out = normalizeLegacyTabs([mk('azito:win'), mk('s:w_01HZZZZZZZZZZZZZZZZZZZZZZZ')]);
    expect(out.map((t) => t.id)).toEqual(['terminal:local/azito:win.2', 'terminal:local/s:w_01HZZZZZZZZZZZZZZZZZZZZZZZ.2']);
    expect(out.every((t) => t.terminalRef === undefined)).toBe(true);
  });
  it('drops a broken tab whose target is not a window target', () => {
    const t: PersistedTab = { id: 'terminal:local::ref:handle.1', type: 'terminal', label: 'h', serverName: 'local', target: 'handle', terminalRef: { kind: 'ref', serverName: 'local', ref: 'handle', pane: 1 } };
    expect(normalizeLegacyTabs([t])).toHaveLength(0);
  });
});
