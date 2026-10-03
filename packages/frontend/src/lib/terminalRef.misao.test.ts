import { describe, it, expect } from 'vitest';
import { taskWindowRegistration, resolveWindowRegistrationRef, registeredWindowTerminalRef, muxRefJson, terminalConnectionKey, refTabMatchesTarget, terminalRefFromTarget, terminalRefFromTabTarget, resolveTabTargetRef, findSessionWindowRef, resolveTerminalRefFromTarget, legacyTargetWsParams } from './terminalRef';
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
  it('a tab target without sessions waits instead of becoming a tmux ref, and is unresolved once sessions lack the window', () => {
    expect(resolveTabTargetRef('local-misao', 'azito:unregistered', { muxKind: 'misao' })).toEqual({ status: 'wait' });
    expect(resolveTabTargetRef('local-misao', 'azito:gone', { muxKind: 'misao', sessions })).toEqual({ status: 'unresolved' });
    expect(resolveTabTargetRef('local-misao', 'w843.2', {})).toEqual({ status: 'ready', ref: { kind: 'windowId', serverName: 'local-misao', windowId: 843, pane: 2 } });
    expect(resolveTabTargetRef('local-misao', 'plain', { muxKind: 'misao' })).toEqual({ status: 'none' });
  });

  it('terminalRefFromTarget resolves a registered misao window to its windowId', () => {
    expect(terminalRefFromTarget('local-misao', 'azito:test-window--nksu', { sessions, muxKind: 'misao' }))
      .toEqual({ kind: 'windowId', serverName: 'local-misao', windowId: 843, pane: 1 });
  });

  it('terminalRefFromTarget keeps the server-reported ref for an unregistered misao window', () => {
    expect(terminalRefFromTarget('local-misao', 'azito:unregistered.2', { sessions, muxKind: 'misao' }))
      .toEqual({ kind: 'ref', serverName: 'local-misao', ref: UNREGISTERED_REF, pane: 2 });
  });

  it('terminalRefFromTabTarget uses sessions when given', () => {
    expect(terminalRefFromTabTarget('local-misao', 'azito:test-window--nksu', { sessions }))
      .toEqual({ kind: 'windowId', serverName: 'local-misao', windowId: 843, pane: 1 });
  });

  it('findSessionWindowRef returns the server-reported ref, or null when the window is unknown', () => {
    expect(findSessionWindowRef(sessions, 'azito:test-window--nksu.1')).toBe(MISAO_REF);
    expect(findSessionWindowRef(sessions, 'azito:missing')).toBeNull();
  });
});

describe('terminalConnectionKey', () => {
  const target = 'azito:test-window--nksu';
  const refFromSessions = terminalRefFromTarget('local-misao', target, { sessions, muxKind: 'misao' });

  it('changes when the ref changes from a tmux-kind ref to a windowId although target is the same', () => {
    const tmuxRef = terminalRefFromTarget('local-misao', target, { muxKind: 'tmux' });
    expect(terminalConnectionKey('local-misao', target, refFromSessions ?? undefined)).not.toBe(terminalConnectionKey('local-misao', target, tmuxRef ?? undefined));
  });

  it('is stable for an equal ref', () => {
    expect(terminalConnectionKey('s', target, refFromSessions ?? undefined))
      .toBe(terminalConnectionKey('s', target, terminalRefFromTarget('local-misao', target, { sessions, muxKind: 'misao' }) ?? undefined));
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

describe('resolveWindowRegistrationRef', () => {
  it('tmux keeps the target-derived ref even without sessions', () => {
    expect(resolveWindowRegistrationRef({ muxKind: 'tmux', target: 'azito:win--abc.1' }))
      .toBe('{"kind":"tmux","workspace":"azito","window":"win--abc"}');
  });

  it('misao uses the ref the terminal was opened with', () => {
    expect(resolveWindowRegistrationRef({
      muxKind: 'misao', target: 'azito:unregistered',
      terminalRef: { kind: 'ref', serverName: 'local-misao', ref: MISAO_REF, pane: 1 },
    })).toBe(MISAO_REF);
  });

  it('misao falls back to the ref in sessions, and is null (never a tmux ref) when unresolved', () => {
    expect(resolveWindowRegistrationRef({ muxKind: 'misao', target: 'azito:unregistered', sessions })).toBe(UNREGISTERED_REF);
    expect(resolveWindowRegistrationRef({ muxKind: 'misao', target: 'azito:unregistered' })).toBeNull();
    expect(resolveWindowRegistrationRef({ muxKind: undefined, target: 'azito:unregistered' })).toBeNull();
  });
});

describe('resolveWindowRegistrationRef before sessions arrive (legacy / persisted tab)', () => {
  const target = 'azito:unregistered';
  // A tmux-kind ref a persisted tab may still carry from before the mux kind was honoured.
  const synthesised = terminalRefFromTabTarget('local-misao', target, { muxKind: 'tmux' });

  it('a tmux-kind ref is not adopted by a misao server', () => {
    expect(synthesised).toMatchObject({ kind: 'ref' });
    expect(resolveWindowRegistrationRef({ muxKind: 'misao', target, terminalRef: synthesised ?? undefined })).toBeNull();
  });

  it('adopts the misao ref from sessions once they arrive, ignoring the synthesised tmux ref', () => {
    expect(resolveWindowRegistrationRef({ muxKind: 'misao', target, terminalRef: synthesised ?? undefined, sessions })).toBe(UNREGISTERED_REF);
  });

  it('waits while the mux kind is unknown, even with a ref present', () => {
    expect(resolveWindowRegistrationRef({ muxKind: undefined, target, terminalRef: synthesised ?? undefined, sessions })).toBeNull();
  });
});

describe('registeredWindowTerminalRef', () => {
  it('opens a just-registered window by the id the API returned', () => {
    expect(registeredWindowTerminalRef('local-misao', 844)).toEqual({ kind: 'windowId', serverName: 'local-misao', windowId: 844, pane: 1 });
  });
});

describe('muxRefJson', () => {
  it('normalises the MuxRef object a window row carries to the string sessions report', () => {
    expect(muxRefJson({ kind: 'misao', workspace: 'azito', window: 'w_01M40229BC46M2RPATEBX4JN25' })).toBe(MISAO_REF);
    expect(muxRefJson(undefined)).toBeUndefined();
  });
});

describe('target resolution against sessions on a misao server', () => {
  const W1 = '{"kind":"misao","workspace":"ws","window":"w_01M40229BC46M2RPATEBX4JN25"}';
  const W2 = '{"kind":"misao","workspace":"ws","window":"w_01M40229BC46M2RPATEBX4JN26"}';
  const W3 = '{"kind":"misao","workspace":"ws","window":"w_01M40229BC46M2RPATEBX4JN27"}';
  const dup: Session[] = [{ name: 'ws', windows: [
    { index: 0, name: 'dup', panes: [], ref: W1, windowId: 1 },
    { index: 1, name: 'dup', panes: [], ref: W2, windowId: 2 },
    { index: 2, name: 'solo', panes: [], ref: W3, windowId: 3 },
  ] }];
  const ctx = { sessions: dup, muxKind: 'misao' as const };
  const ref = (windowId: number, pane = 1) => ({ status: 'ready', ref: { kind: 'windowId', serverName: 's', windowId, pane } });

  it('resolves an id target, an index, and a unique name', () => {
    expect(resolveTerminalRefFromTarget('s', 'ws:w_01M40229BC46M2RPATEBX4JN26', ctx)).toEqual(ref(2));
    expect(resolveTerminalRefFromTarget('s', 'ws:w_01M40229BC46M2RPATEBX4JN27.2', ctx)).toEqual(ref(3, 2));
    expect(resolveTerminalRefFromTarget('s', 'ws:1', ctx)).toEqual(ref(2));
    expect(resolveTerminalRefFromTarget('s', 'ws:solo', ctx)).toEqual(ref(3));
  });

  it('never connects to an arbitrary one of several windows sharing a name', () => {
    expect(resolveTerminalRefFromTarget('s', 'ws:dup', ctx)).toEqual({ status: 'unresolved' });
  });

  it('a tmux server keeps its first-match naming', () => {
    expect(resolveTerminalRefFromTarget('s', 'ws:dup', { sessions: dup, muxKind: 'tmux' })).toEqual(ref(1));
  });
});

describe('legacyTargetWsParams', () => {
  it('sends the window part and the pane apart', () => {
    expect(legacyTargetWsParams('s', 'ws:win.2', 80, 24)).toEqual({ server: 's', target: 'ws:win', pane: '2', cols: '80', rows: '24' });
    expect(legacyTargetWsParams('s', 'ws:win', 80, 24).pane).toBe('1');
  });
});

describe('taskWindowRegistration', () => {
  const misaoRef = JSON.stringify({ kind: 'misao', workspace: 'azito', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' });
  const tmuxRef = JSON.stringify({ kind: 'tmux', workspace: 'azito', window: 'win' });

  it('keeps the name target and sends no ref for tmux', () => {
    expect(taskWindowRegistration({ muxKind: 'tmux', target: 'azito:win', ref: tmuxRef })).toEqual({ target: 'azito:win' });
  });

  it('sends the ref and a ref-derived target for misao', () => {
    expect(taskWindowRegistration({ muxKind: 'misao', target: 'azito:display', ref: misaoRef }))
      .toEqual({ target: 'azito:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8', ref: misaoRef });
  });

  it('is null for misao without a ref, with a tmux-kind ref, or an unknown server kind', () => {
    expect(taskWindowRegistration({ muxKind: 'misao', target: 'azito:display', ref: null })).toBeNull();
    expect(taskWindowRegistration({ muxKind: 'misao', target: 'azito:display', ref: tmuxRef })).toBeNull();
    expect(taskWindowRegistration({ muxKind: undefined, target: 'azito:display', ref: misaoRef })).toBeNull();
  });
});
