import { describe, it, expect } from 'vitest';
import { formatMuxRef, parseMuxRef, muxRefFromTmuxTarget, tmuxTargetFromMuxRef, windowKeyForRef, type MuxRef } from './mux';
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
    expect(() => parseMuxRef('{"kind":"zellij","workspace":"x","window":"y"}')).toThrow('Unknown MuxDriverKind: zellij');
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
