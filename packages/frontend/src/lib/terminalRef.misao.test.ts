import { describe, it, expect } from 'vitest';
import { taskWindowRegistration, resolveWindowRegistrationRef, registeredWindowTerminalRef, muxRefJson, terminalConnectionKey, refTabMatchesTarget, terminalRefFromTarget, terminalRefFromTabTarget, findSessionWindowRef } from './terminalRef';
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
  // What terminalRefFromTabTarget synthesises from the target while sessions are still missing.
  const synthesised = terminalRefFromTabTarget('local-misao', target);

  it('synthesises a tmux-kind ref, which a misao server must not adopt', () => {
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
