import { describe, it, expect } from 'vitest';
import {
  terminalTabId,
  parseTerminalTabId,
  terminalWsParams,
  windowApiPath,
  paneApiPath,
  paneDeletePath,
  terminalRefFromWindow,
  terminalRefFromTarget,
  resolveTerminalRefFromTarget,
  isValidTerminalRef,
  resolveTerminalTarget,
  windowKillRequest,
  terminalRefFromTabTarget,
  terminalRefDisplayLabel,
  retargetedTerminalRef,
  type TerminalRef,
} from './terminalRef';
import { parseMuxRef } from '@azito/shared';
import type { Session } from '../pages/workspace/types';

describe('terminalTabId', () => {
  it('generates windowId-based tab ID', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'local', windowId: 12, pane: 1 };
    expect(terminalTabId(ref)).toBe('terminal:local::w12.1');
  });

  it('generates ref-based tab ID', () => {
    const ref: TerminalRef = { kind: 'ref', serverName: 'local', ref: '{"kind":"tmux","workspace":"azito","window":"win--abc"}', pane: 0 };
    expect(terminalTabId(ref)).toBe(
      `terminal:local::ref:${encodeURIComponent('{"kind":"tmux","workspace":"azito","window":"win--abc"}')}.0`,
    );
  });
});

describe('parseTerminalTabId', () => {
  it('parses windowId-based tab ID', () => {
    expect(parseTerminalTabId('terminal:local::w12.1')).toEqual({
      kind: 'windowId', serverName: 'local', windowId: 12, pane: 1,
    });
  });

  it('parses ref-based tab ID', () => {
    const ref = '{"kind":"tmux","workspace":"azito","window":"win--abc"}';
    const id = `terminal:local::ref:${encodeURIComponent(ref)}.0`;
    expect(parseTerminalTabId(id)).toEqual({
      kind: 'ref', serverName: 'local', ref, pane: 0,
    });
  });

  it('parses legacy tab ID terminal:server/session:window.pane', () => {
    expect(parseTerminalTabId('terminal:local/azito:win--abc.1')).toEqual({
      kind: 'legacy', serverName: 'local', target: 'azito:win--abc', pane: 1,
    });
  });

  it('parses legacy tab ID without pane suffix', () => {
    expect(parseTerminalTabId('terminal:local/azito:win--abc')).toEqual({
      kind: 'legacy', serverName: 'local', target: 'azito:win--abc', pane: 1,
    });
  });

  it('returns null for non-terminal IDs', () => {
    expect(parseTerminalTabId('task:42')).toBeNull();
  });
});

describe('terminalWsParams', () => {
  it('produces windowId-based params', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'local', windowId: 5, pane: 1 };
    expect(terminalWsParams(ref, 80, 24)).toEqual({
      server: 'local', windowId: '5', pane: '1', cols: '80', rows: '24',
    });
  });

  it('produces ref-based params', () => {
    const ref: TerminalRef = { kind: 'ref', serverName: 'srv', ref: '{"kind":"tmux","workspace":"s","window":"w"}', pane: 0 };
    expect(terminalWsParams(ref, 120, 40)).toEqual({
      server: 'srv', ref: '{"kind":"tmux","workspace":"s","window":"w"}', pane: '0', cols: '120', rows: '40',
    });
  });
});

describe('windowApiPath / paneApiPath', () => {
  it('windowApiPath for windowId ref', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'local', windowId: 7, pane: 1 };
    expect(windowApiPath(ref, 'kill')).toBe('/windows/7/kill');
    expect(windowApiPath(ref)).toBe('/windows/7');
  });

  it('windowApiPath for mux ref', () => {
    const ref: TerminalRef = { kind: 'ref', serverName: 'srv', ref: 'ABC', pane: 1 };
    expect(windowApiPath(ref, 'rename')).toBe('/servers/srv/mux/windows/ABC/rename');
  });

  it('paneApiPath for windowId ref', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'local', windowId: 7, pane: 2 };
    expect(paneApiPath(ref, 'zoom')).toBe('/windows/7/panes/2/zoom');
    expect(paneApiPath(ref)).toBe('/windows/7/panes/2');
  });

  it('paneApiPath for mux ref', () => {
    const ref: TerminalRef = { kind: 'ref', serverName: 'srv', ref: 'ABC', pane: 3 };
    expect(paneApiPath(ref, 'send-keys')).toBe('/servers/srv/mux/windows/ABC/panes/3/send-keys');
  });

  it('paneDeletePath carries the pane handle when known, else only the ordinal', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'local', windowId: 7, pane: 2 };
    expect(paneDeletePath(ref, 'p_01ABC')).toBe('/windows/7/panes/2?handle=p_01ABC');
    expect(paneDeletePath(ref, '%12')).toBe('/windows/7/panes/2?handle=%2512');
    expect(paneDeletePath(ref)).toBe('/windows/7/panes/2');
  });
});

describe('terminalRefFromWindow', () => {
  it('returns windowId ref when windowId is present', () => {
    expect(terminalRefFromWindow('local', 5, 'anyref', 1)).toEqual({
      kind: 'windowId', serverName: 'local', windowId: 5, pane: 1,
    });
  });

  it('returns ref-based when windowId is null', () => {
    expect(terminalRefFromWindow('local', null, 'theref', 0)).toEqual({
      kind: 'ref', serverName: 'local', ref: 'theref', pane: 0,
    });
  });
});

describe('terminalRefFromTarget on a tmux server', () => {
  const tmux = { muxKind: 'tmux' as const };
  const refOf = (target: string) => {
    const ref = terminalRefFromTarget('srv', target, tmux);
    if (!ref) throw new Error('expected a ref');
    return ref;
  };

  it('produces a ref with parseMuxRef-valid JSON for a standard target', () => {
    const ref = refOf('azito:win--abc.2');
    expect(ref.kind).toBe('ref');
    expect(ref.pane).toBe(2);
    if (ref.kind === 'ref') {
      expect(parseMuxRef(ref.ref)).toEqual({ kind: 'tmux', workspace: 'azito', window: 'win--abc' });
    }
  });

  it('preserves pane number from target suffix', () => {
    expect(refOf('main:0.3').pane).toBe(3);
  });

  it('defaults to pane 1 when no suffix', () => {
    expect(refOf('main:0').pane).toBe(1);
  });

  it('produces valid ref even for target without colon', () => {
    const ref = refOf('bare');
    expect(ref.kind).toBe('ref');
    if (ref.kind === 'ref') {
      expect(() => parseMuxRef(ref.ref)).not.toThrow();
    }
  });

  it('prefers the window the sessions report', () => {
    const sessions: Session[] = [{ name: 'azito', windows: [{ index: 0, name: 'win--abc', panes: [], ref: '{"kind":"tmux","workspace":"azito","window":"win--abc"}', windowId: 12 }] }];
    expect(terminalRefFromTarget('srv', 'azito:win--abc.2', { ...tmux, sessions })).toEqual({ kind: 'windowId', serverName: 'srv', windowId: 12, pane: 2 });
  });

  it('roundtrips through terminalTabId/parseTerminalTabId', () => {
    const parsed = parseTerminalTabId(terminalTabId(refOf('azito:win--abc.1')));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('ref');
  });
});

describe('resolveTerminalRefFromTarget on a non-tmux server', () => {
  it('never synthesises a tmux ref: it waits for the mux kind, then for sessions, and is unresolved when the window is not listed', () => {
    expect(resolveTerminalRefFromTarget('s', 'ws:win')).toEqual({ status: 'wait' });
    expect(resolveTerminalRefFromTarget('s', 'ws:win', { muxKind: 'misao' })).toEqual({ status: 'wait' });
    expect(resolveTerminalRefFromTarget('s', 'ws:win', { muxKind: 'misao', sessions: [] })).toEqual({ status: 'unresolved' });
  });

  it('waits for the mux kind even when sessions are loaded but do not list the window', () => {
    expect(resolveTerminalRefFromTarget('s', 'ws:win', { sessions: [] })).toEqual({ status: 'wait' });
  });
});

describe('terminalRefDisplayLabel', () => {
  it('shows W-N for windowId refs', () => {
    expect(terminalRefDisplayLabel({ kind: 'windowId', serverName: 'x', windowId: 42, pane: 1 })).toBe('W-42');
  });

  it('shows workspace:window for valid mux ref', () => {
    const ref = '{"kind":"tmux","workspace":"sess","window":"win"}';
    expect(terminalRefDisplayLabel({ kind: 'ref', serverName: 'x', ref, pane: 1 })).toBe('sess:win');
  });
});

describe('isValidTerminalRef', () => {
  it('accepts integer windowId and non-empty ref forms', () => {
    expect(isValidTerminalRef({ kind: 'windowId', serverName: 'local', windowId: 729, pane: 1 })).toBe(true);
    expect(isValidTerminalRef({ kind: 'ref', serverName: 'local', ref: '{"kind":"tmux","workspace":"a","window":"b"}', pane: 2 })).toBe(true);
  });
  it('rejects an object, string, or missing windowId and a stringified object ref', () => {
    expect(isValidTerminalRef({ kind: 'windowId', serverName: 'local', windowId: { id: 729 }, pane: 1 })).toBe(false);
    expect(isValidTerminalRef({ kind: 'windowId', serverName: 'local', windowId: '729', pane: 1 })).toBe(false);
    expect(isValidTerminalRef({ kind: 'windowId', serverName: 'local', pane: 1 })).toBe(false);
    expect(isValidTerminalRef({ kind: 'ref', serverName: 'local', ref: 'w[object Object]', pane: 1 })).toBe(false);
    expect(isValidTerminalRef(null)).toBe(false);
  });
});

describe('resolveTerminalTarget / terminalRefFromTabTarget (rc.7 follow-up)', () => {
  const sessions = [{ name: 'azito', windows: [
    { index: 17, name: 'win--qvp6', ref: JSON.stringify({ kind: 'tmux', workspace: 'azito', window: 'win--qvp6' }), windowId: 729, panes: [] },
  ] }] as unknown as import('../pages/workspace/types').Session[];

  it('resolves a windowId ref to the live tmux target via sessions', () => {
    expect(resolveTerminalTarget({ kind: 'windowId', serverName: 'server007', windowId: 729, pane: 1 }, sessions)).toBe('azito:win--qvp6.1');
  });
  it('returns null for a windowId that is not in sessions yet', () => {
    expect(resolveTerminalTarget({ kind: 'windowId', serverName: 'server007', windowId: 1, pane: 1 }, sessions)).toBeNull();
    expect(resolveTerminalTarget({ kind: 'windowId', serverName: 'server007', windowId: 729, pane: 1 }, undefined)).toBeNull();
  });
  it('resolves a ref form without sessions', () => {
    expect(resolveTerminalTarget({ kind: 'ref', serverName: 's', ref: JSON.stringify({ kind: 'tmux', workspace: 'azito', window: 'x' }), pane: 2 }, undefined)).toBe('azito:x.2');
  });
  it('resolves a misao ref through the window name in sessions, never to its window id', () => {
    const windowId = 'w_0123456789ABCDEFGHJKMNPQRS';
    const ref = JSON.stringify({ kind: 'misao', workspace: 'default', window: windowId });
    const misaoSessions = [{ name: 'default', windows: [{ index: 1, name: 'main', ref, windowId: null, panes: [] }] }] as unknown as import('../pages/workspace/types').Session[];
    expect(resolveTerminalTarget({ kind: 'ref', serverName: 's', ref, pane: 2 }, misaoSessions)).toBe('default:main.2');
    expect(resolveTerminalTarget({ kind: 'ref', serverName: 's', ref, pane: 2 }, undefined)).toBeNull();
    expect(resolveTerminalTarget({ kind: 'ref', serverName: 's', ref, pane: 2 }, sessions)).toBeNull();
  });
  it('recovers the windowId form from the w<id> placeholder target', () => {
    expect(terminalRefFromTabTarget('server007', 'w729')).toEqual({ kind: 'windowId', serverName: 'server007', windowId: 729, pane: 1 });
    expect(terminalRefFromTabTarget('server007', 'w729.2')).toEqual({ kind: 'windowId', serverName: 'server007', windowId: 729, pane: 2 });
    expect(terminalRefFromTabTarget('server007', 'azito:win--qvp6.1', { muxKind: 'tmux' })?.kind).toBe('ref');
    expect(terminalRefFromTabTarget('server007', 'w[object Object]')).toBeNull();
  });
});

describe('windowKillRequest', () => {
  it('uses DELETE /windows/:id/kill for a registered window', () => {
    expect(windowKillRequest({ kind: 'windowId', serverName: 's', windowId: 7, pane: 1 })).toEqual({ path: '/windows/7/kill', method: 'DELETE' });
  });
  it('uses POST on the mux route for a ref', () => {
    const ref = '{"kind":"misao","workspace":"d","window":"w_x"}';
    expect(windowKillRequest({ kind: 'ref', serverName: 's', ref, pane: 1 })).toEqual({ path: `/servers/s/mux/windows/${encodeURIComponent(ref)}/kill`, method: 'POST' });
  });
});

const win = (windowId: number, paneCount: number): Session => ({
  name: 's',
  windows: [{ index: 0, name: 'w', ref: '', windowId, panes: Array.from({ length: paneCount }, (_, i) => ({ index: i, title: '', command: '', width: 1, height: 1, active: i === 0 })) }],
});

describe('retargetedTerminalRef', () => {
  it('always yields a windowId ref, keeping the pane of a windowId tab', () => {
    expect(retargetedTerminalRef('terminal:local::w7.3', 'local', 9, [win(9, 3)])).toEqual({ kind: 'windowId', serverName: 'local', windowId: 9, pane: 3 });
  });

  it('keeps the pane of a ref-form tab (tmux and misao refs alike)', () => {
    const tmux = terminalTabId({ kind: 'ref', serverName: 'local', ref: '{"kind":"tmux","workspace":"azito","window":"w"}', pane: 2 });
    const misao = terminalTabId({ kind: 'ref', serverName: 'local', ref: '{"kind":"misao","workspace":"a","window":"b"}', pane: 2 });
    expect(retargetedTerminalRef(tmux, 'local', 5, [win(5, 2)])).toEqual({ kind: 'windowId', serverName: 'local', windowId: 5, pane: 2 });
    expect(retargetedTerminalRef(misao, 'local', 5, [win(5, 2)])).toEqual({ kind: 'windowId', serverName: 'local', windowId: 5, pane: 2 });
  });

  it('falls back to pane 1 for a legacy or unparsable tab id', () => {
    expect(retargetedTerminalRef('terminal:local/azito:win.4', 'local', 5).pane).toBe(1);
    expect(retargetedTerminalRef('nonsense', 'local', 5).pane).toBe(1);
  });

  it('produces a tab id that round-trips and never carries a raw tmux target', () => {
    const ref = retargetedTerminalRef('terminal:local::w7.1', 'local', 9);
    expect(isValidTerminalRef(ref)).toBe(true);
    expect(parseTerminalTabId(terminalTabId(ref))).toEqual(ref);
  });
});
