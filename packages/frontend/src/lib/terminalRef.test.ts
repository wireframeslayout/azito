import { describe, it, expect } from 'vitest';
import {
  terminalTabId,
  parseTerminalTabId,
  terminalWsParams,
  windowApiPath,
  paneApiPath,
  terminalRefFromWindow,
  terminalRefFromTarget,
  migrateLegacyTerminalTabs,
  terminalRefDisplayLabel,
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

describe('migrateLegacyTerminalTabs', () => {
  const sessions: Session[] = [{
    name: 'azito',
    windows: [
      { index: 0, name: 'win--abc', panes: [], ref: '{"kind":"tmux","workspace":"azito","window":"win--abc"}', windowId: 12 },
      { index: 1, name: 'win--def', panes: [], ref: '{"kind":"tmux","workspace":"azito","window":"win--def"}', windowId: null },
    ],
  }];
  const sessionsByServer = new Map([['local', sessions]]);

  it('maps legacy tab to windowId when found', () => {
    const result = migrateLegacyTerminalTabs(['terminal:local/azito:win--abc.1'], sessionsByServer);
    expect(result.get('terminal:local/azito:win--abc.1')).toBe('terminal:local::w12.1');
  });

  it('maps legacy tab to ref when windowId is null', () => {
    const result = migrateLegacyTerminalTabs(['terminal:local/azito:win--def.1'], sessionsByServer);
    const expected = `terminal:local::ref:${encodeURIComponent('{"kind":"tmux","workspace":"azito","window":"win--def"}')}.1`;
    expect(result.get('terminal:local/azito:win--def.1')).toBe(expected);
  });

  it('maps legacy tab to synthetic ref when not found in sessions', () => {
    const result = migrateLegacyTerminalTabs(['terminal:local/azito:win--gone.1'], sessionsByServer);
    const id = result.get('terminal:local/azito:win--gone.1')!;
    expect(id).toMatch(/^terminal:local::ref:/);
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

describe('terminalRefFromTarget', () => {
  it('produces a ref with parseMuxRef-valid JSON for a standard target', () => {
    const ref = terminalRefFromTarget('local', 'azito:win--abc.2');
    expect(ref.kind).toBe('ref');
    expect(ref.pane).toBe(2);
    if (ref.kind === 'ref') {
      const parsed = parseMuxRef(ref.ref);
      expect(parsed).toEqual({ kind: 'tmux', workspace: 'azito', window: 'win--abc' });
    }
  });

  it('preserves pane number from target suffix', () => {
    const ref = terminalRefFromTarget('srv', 'main:0.3');
    expect(ref.pane).toBe(3);
  });

  it('defaults to pane 1 when no suffix', () => {
    const ref = terminalRefFromTarget('srv', 'main:0');
    expect(ref.pane).toBe(1);
  });

  it('produces valid ref even for target without colon', () => {
    const ref = terminalRefFromTarget('srv', 'bare');
    expect(ref.kind).toBe('ref');
    if (ref.kind === 'ref') {
      expect(() => parseMuxRef(ref.ref)).not.toThrow();
    }
  });

  it('roundtrips through terminalTabId/parseTerminalTabId', () => {
    const ref = terminalRefFromTarget('local', 'azito:win--abc.1');
    const tabId = terminalTabId(ref);
    const parsed = parseTerminalTabId(tabId);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('ref');
  });
});

describe('terminalRefDisplayLabel', () => {
  it('shows wN for windowId refs', () => {
    expect(terminalRefDisplayLabel({ kind: 'windowId', serverName: 'x', windowId: 42, pane: 1 })).toBe('w42');
  });

  it('shows workspace:window for valid mux ref', () => {
    const ref = '{"kind":"tmux","workspace":"sess","window":"win"}';
    expect(terminalRefDisplayLabel({ kind: 'ref', serverName: 'x', ref, pane: 1 })).toBe('sess:win');
  });
});
