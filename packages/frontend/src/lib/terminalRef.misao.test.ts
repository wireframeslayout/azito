import { describe, it, expect } from 'vitest';
import { terminalConnectionKey, refTabMatchesTarget, terminalRefFromTarget, terminalRefFromTabTarget, findSessionWindowRef } from './terminalRef';
import type { Session } from '../pages/workspace/types';

const MISAO_REF = '{"kind":"misao","workspace":"azito","window":"w_01M40229BC46M2RPATEBX4JN25"}';
const UNREGISTERED_REF = '{"kind":"misao","workspace":"azito","window":"w_02"}';

const sessions: Session[] = [{
  name: 'azito',
  windows: [
    { index: 0, name: 'test-window--nksu', panes: [], ref: MISAO_REF, windowId: 843 },
    { index: 1, name: 'unregistered', panes: [], ref: UNREGISTERED_REF, windowId: null },
  ],
}];

describe('misao windows are never turned into a tmux-kind ref', () => {
  it('terminalRefFromTarget resolves a registered misao window to its windowId', () => {
    expect(terminalRefFromTarget('local-misao', 'azito:test-window--nksu', sessions))
      .toEqual({ kind: 'windowId', serverName: 'local-misao', windowId: 843, pane: 1 });
  });

  it('terminalRefFromTarget keeps the server-reported ref for an unregistered misao window', () => {
    expect(terminalRefFromTarget('local-misao', 'azito:unregistered.2', sessions))
      .toEqual({ kind: 'ref', serverName: 'local-misao', ref: UNREGISTERED_REF, pane: 2 });
  });

  it('terminalRefFromTabTarget uses sessions when given', () => {
    expect(terminalRefFromTabTarget('local-misao', 'azito:test-window--nksu', sessions))
      .toEqual({ kind: 'windowId', serverName: 'local-misao', windowId: 843, pane: 1 });
  });

  it('findSessionWindowRef returns the server-reported ref, or null when the window is unknown', () => {
    expect(findSessionWindowRef(sessions, 'azito:test-window--nksu.1')).toBe(MISAO_REF);
    expect(findSessionWindowRef(sessions, 'azito:missing')).toBeNull();
  });
});

describe('terminalConnectionKey', () => {
  it('changes when the ref changes from a tmux-kind ref to a windowId although target is the same', () => {
    const target = 'azito:test-window--nksu';
    const before = terminalConnectionKey('local-misao', target, terminalRefFromTarget('local-misao', target));
    const after = terminalConnectionKey('local-misao', target, terminalRefFromTarget('local-misao', target, sessions));
    expect(after).not.toBe(before);
  });

  it('is stable for an equal ref', () => {
    const target = 'azito:test-window--nksu';
    expect(terminalConnectionKey('s', target, terminalRefFromTarget('s', target, sessions)))
      .toBe(terminalConnectionKey('s', target, terminalRefFromTarget('s', target, sessions)));
  });
});

describe('refTabMatchesTarget', () => {
  it('matches a misao ref tab with the <workspace>:<window id> target of a ref-only row', () => {
    expect(refTabMatchesTarget(MISAO_REF, 'azito:w_01M40229BC46M2RPATEBX4JN25.1')).toBe(true);
    expect(refTabMatchesTarget(MISAO_REF, 'azito:other')).toBe(false);
  });

  it('keeps matching a tmux ref tab by the tmux target', () => {
    const tmuxRef = '{"kind":"tmux","workspace":"azito","window":"win--abc"}';
    expect(refTabMatchesTarget(tmuxRef, 'azito:win--abc.2')).toBe(true);
    expect(refTabMatchesTarget(tmuxRef, 'azito:win--xyz')).toBe(false);
  });

  it('is false for an unparseable ref', () => {
    expect(refTabMatchesTarget('not-json', 'azito:win')).toBe(false);
  });
});
