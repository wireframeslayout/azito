import { describe, it, expect } from 'vitest';
import { formatMuxRef, parseMuxRef, muxRefFromTmuxTarget, tmuxTargetFromMuxRef, windowKeyForRef, muxKindForRuntime, herdrPaneHandle, parseHerdrPaneHandle, herdrMuxRef, type MuxRef } from './mux';
import { windowKey } from './windowKey';

describe('formatMuxRef / parseMuxRef', () => {
  it('round-trips a valid MuxRef', () => {
    const ref: MuxRef = { kind: 'tmux', workspace: 'main', window: 'win--abc' };
    const json = formatMuxRef(ref);
    expect(parseMuxRef(json)).toEqual(ref);
  });
  it('produces stable key order', () => {
    const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'w' };
    expect(formatMuxRef(ref)).toBe('{"kind":"tmux","workspace":"sess","window":"w"}');
  });
  it('throws on unknown kind', () => {
    expect(() => parseMuxRef('{"kind":"screen","workspace":"x","window":"y"}')).toThrow('Unknown MuxDriverKind: screen');
  });
  it('accepts herdr kind', () => {
    const ref = parseMuxRef('{"kind":"herdr","workspace":"ws","window":"w1"}');
    expect(ref).toEqual({ kind: 'herdr', workspace: 'ws', window: 'w1' });
  });
  it('accepts zellij kind', () => {
    const ref = parseMuxRef('{"kind":"zellij","workspace":"ws","window":"w1"}');
    expect(ref).toEqual({ kind: 'zellij', workspace: 'ws', window: 'w1' });
  });
});

describe('muxRefFromTmuxTarget', () => {
  it('parses session:window', () => {
    expect(muxRefFromTmuxTarget('main:win--abc')).toEqual({ kind: 'tmux', workspace: 'main', window: 'win--abc' });
  });
  it('strips pane suffix .N', () => {
    expect(muxRefFromTmuxTarget('main:win--abc.1')).toEqual({ kind: 'tmux', workspace: 'main', window: 'win--abc' });
  });
  it('throws when colon is missing', () => {
    expect(() => muxRefFromTmuxTarget('nocolon')).toThrow('missing ":"');
  });
});

describe('tmuxTargetFromMuxRef', () => {
  it('reconstructs target', () => {
    expect(tmuxTargetFromMuxRef({ kind: 'tmux', workspace: 'azito', window: 'win--x' })).toBe('azito:win--x');
  });
});

describe('windowKeyForRef', () => {
  it('produces same output as windowKey', () => {
    const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win--abc' };
    expect(windowKeyForRef('server01', ref)).toBe(windowKey('server01', 'sess:win--abc'));
  });
});

describe('muxKindForRuntime', () => {
  it('maps system to tmux', () => {
    expect(muxKindForRuntime('system')).toBe('tmux');
  });
  it('maps managed to tmux', () => {
    expect(muxKindForRuntime('managed')).toBe('tmux');
  });
  it('maps herdr to herdr', () => {
    expect(muxKindForRuntime('herdr')).toBe('herdr');
  });
  it('maps zellij to zellij', () => {
    expect(muxKindForRuntime('zellij')).toBe('zellij');
  });
});

describe('herdrPaneHandle / parseHerdrPaneHandle', () => {
  it('creates a branded handle', () => {
    const h = herdrPaneHandle('ws1', 'p1');
    expect(h as string).toBe('ws1:p1');
  });
  it('round-trips', () => {
    const h = herdrPaneHandle('ws1', 'p2');
    expect(parseHerdrPaneHandle(h)).toEqual({ workspaceId: 'ws1', paneId: 'p2' });
  });
  it('throws on missing colon', () => {
    expect(() => parseHerdrPaneHandle('nocolon' as any)).toThrow('missing ":"');
  });
});

describe('herdrMuxRef', () => {
  it('creates a herdr MuxRef', () => {
    expect(herdrMuxRef('myworkspace', 'mytab')).toEqual({
      kind: 'herdr', workspace: 'myworkspace', window: 'mytab',
    });
  });
});
