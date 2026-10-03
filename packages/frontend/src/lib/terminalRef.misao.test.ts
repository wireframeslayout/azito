import { describe, it, expect } from 'vitest';
import { terminalRefFromTarget, terminalRefFromTabTarget, findSessionWindowRef } from './terminalRef';
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
