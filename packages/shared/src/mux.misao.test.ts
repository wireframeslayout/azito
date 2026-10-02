import { describe, it, expect } from 'vitest';
import { formatMuxRef, parseMuxRef, tmuxTargetFromMuxRef, windowKeyForRef, muxKindForRuntime, isPaneHandleLike, type MuxRef } from './mux';

const WINDOW_ID = 'w_01J8ZK3M5N7P9Q2R4S6T8V0WXY';
const PANE_ID = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXY';

describe('misao MuxRef', () => {
  it('maps the misao runtime to the misao kind', () => {
    expect(muxKindForRuntime('misao')).toBe('misao');
  });

  it('round-trips a misao ref', () => {
    const ref: MuxRef = { kind: 'misao', workspace: 'ws', window: WINDOW_ID };
    expect(parseMuxRef(formatMuxRef(ref))).toEqual(ref);
  });

  it('rejects a misao ref whose window is not a w_<ULID>', () => {
    expect(() => parseMuxRef('{"kind":"misao","workspace":"x","window":"main:1"}')).toThrow('Invalid misao window id');
    expect(() => parseMuxRef(`{"kind":"misao","workspace":"x","window":"${PANE_ID}"}`)).toThrow('Invalid misao window id');
    expect(() => parseMuxRef('{"kind":"misao","workspace":"x"}')).toThrow('Invalid misao window id');
  });

  it('still rejects unknown kinds', () => {
    expect(() => parseMuxRef('{"kind":"screen","workspace":"x","window":"y"}')).toThrow('Unsupported MuxRef kind: screen');
  });

  it('builds a window key from the window id only', () => {
    expect(windowKeyForRef('srv', { kind: 'misao', workspace: 'ws', window: WINDOW_ID })).toBe(`srv::${WINDOW_ID}`);
    expect(windowKeyForRef('srv', { kind: 'tmux', workspace: 'main', window: 'w1' })).toBe('srv::main:w1');
  });

  it('refuses to derive a tmux target from a non-tmux ref', () => {
    expect(() => tmuxTargetFromMuxRef({ kind: 'misao', workspace: 'ws', window: WINDOW_ID })).toThrow('misao');
  });
});

describe('isPaneHandleLike', () => {
  it('judges tmux handles', () => {
    expect(isPaneHandleLike('%12', 'tmux')).toBe(true);
    expect(isPaneHandleLike(PANE_ID, 'tmux')).toBe(false);
  });

  it('judges misao handles', () => {
    expect(isPaneHandleLike(PANE_ID, 'misao')).toBe(true);
    expect(isPaneHandleLike('%12', 'misao')).toBe(false);
    expect(isPaneHandleLike(WINDOW_ID, 'misao')).toBe(false);
    expect(isPaneHandleLike('p_81J8ZK3M5N7P9Q2R4S6T8V0WXY', 'misao')).toBe(false);
  });
});
