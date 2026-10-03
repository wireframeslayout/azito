import { describe, it, expect } from 'vitest';
import { formatMuxRef } from '@azito/shared';
import type { MuxRef } from '@azito/shared';
import { findSessionWindow, isTerminalTabActive } from './windowMatch';
import type { Session, TmuxWindow } from '../pages/workspace/types';

function tmuxWin(index: number, name: string, windowId: number | null = null, sessionName = 'main'): TmuxWindow {
  const ref: MuxRef = { kind: 'tmux', workspace: sessionName, window: name };
  return { index, name, ref: formatMuxRef(ref), windowId, panes: [] };
}

const misaoRef: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01HZZZZZZZZZZZZZZZZZZZZZZZ' } as MuxRef;

function misaoWin(name: string, windowId: number | null): TmuxWindow {
  return { index: 1, name, ref: formatMuxRef(misaoRef), windowId, panes: [] };
}

describe('findSessionWindow', () => {
  it('matches a tmux window by its session:window target', () => {
    const sessions: Session[] = [{ name: 'main', windows: [tmuxWin(0, 'editor'), tmuxWin(1, 'win--ab12')] }];
    const m = findSessionWindow({ id: 5, tmuxTarget: 'main:win--ab12.1' }, sessions);
    expect(m?.window.name).toBe('win--ab12');
    expect(m?.session.name).toBe('main');
  });

  it('matches a tmux window by index', () => {
    const sessions: Session[] = [{ name: 'main', windows: [tmuxWin(0, 'editor'), tmuxWin(1, 'shell')] }];
    expect(findSessionWindow({ id: 5, tmuxTarget: 'main:1.1' }, sessions)?.window.name).toBe('shell');
  });

  it('matches a misao window ULID target through its windowId even though the listed name is a display name', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [misaoWin('win--xxxx', 42)] }];
    const m = findSessionWindow({ id: 42, tmuxTarget: 'ws:w_01HZZZZZZZZZZZZZZZZZZZZZZZ' }, sessions);
    expect(m?.window.name).toBe('win--xxxx');
  });

  it('matches a misao window through muxRef when the listing carries no windowId', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [misaoWin('shell', null)] }];
    const m = findSessionWindow({ id: 7, tmuxTarget: 'ws:w_01HZZZZZZZZZZZZZZZZZZZZZZZ', muxRef: misaoRef }, sessions);
    expect(m?.window.name).toBe('shell');
  });

  it('does not match a misao window that has neither a windowId nor a muxRef to go by', () => {
    const sessions: Session[] = [{ name: 'ws', windows: [misaoWin('win--xxxx', null)] }];
    expect(findSessionWindow({ id: 7, tmuxTarget: 'ws:w_01HZZZZZZZZZZZZZZZZZZZZZZZ' }, sessions)).toBeNull();
  });

  it('prefers the windowId match over a same-named window in the target session', () => {
    const sessions: Session[] = [
      { name: 'a', windows: [tmuxWin(0, 'work', null, 'a')] },
      { name: 'b', windows: [tmuxWin(0, 'work', 9, 'b')] },
    ];
    const m = findSessionWindow({ id: 9, tmuxTarget: 'a:work.1' }, sessions);
    expect(m?.session.name).toBe('b');
  });

  it('keeps the target session when a same-named window exists elsewhere and no id matches', () => {
    const sessions: Session[] = [
      { name: 'a', windows: [tmuxWin(0, 'work', null, 'a')] },
      { name: 'b', windows: [tmuxWin(0, 'work', null, 'b')] },
    ];
    expect(findSessionWindow({ id: 9, tmuxTarget: 'b:work.1' }, sessions)?.session.name).toBe('b');
  });

  it('matches a window name that contains a dot before stripping a pane suffix', () => {
    const sessions: Session[] = [{ name: 'main', windows: [tmuxWin(0, 'foo.bar')] }];
    expect(findSessionWindow({ id: 5, tmuxTarget: 'main:foo.bar' }, sessions)?.window.name).toBe('foo.bar');
    expect(findSessionWindow({ id: 5, tmuxTarget: 'main:foo.bar.1' }, sessions)?.window.name).toBe('foo.bar');
  });

  it('falls back to the label when the target window is gone', () => {
    const sessions: Session[] = [{ name: 'main', windows: [tmuxWin(0, 'renamed')] }];
    expect(findSessionWindow({ id: 5, tmuxTarget: 'main:old.1', label: 'renamed' }, sessions)?.window.name).toBe('renamed');
  });

  it('returns null when the session or window is missing', () => {
    const sessions: Session[] = [{ name: 'main', windows: [tmuxWin(0, 'editor')] }];
    expect(findSessionWindow({ id: 5, tmuxTarget: 'other:editor.1' }, sessions)).toBeNull();
    expect(findSessionWindow({ id: 5, tmuxTarget: 'main:nope.1' }, sessions)).toBeNull();
    expect(findSessionWindow({ id: 5, tmuxTarget: 'main:editor.1' }, [])).toBeNull();
  });
});

describe('isTerminalTabActive', () => {
  it('matches a windowId tab by windowId at window level regardless of the pane', () => {
    expect(isTerminalTabActive('terminal:local::w12.2', 'local', 'ws:w_X.1', 'window', 12)).toBe(true);
  });

  it('matches a windowId tab at pane level only for the same pane ordinal', () => {
    expect(isTerminalTabActive('terminal:local::w12.2', 'local', 'ws:w_X.2', 'pane', 12)).toBe(true);
    expect(isTerminalTabActive('terminal:local::w12.2', 'local', 'ws:w_X.1', 'pane', 12)).toBe(false);
  });

  it('does not match another window or server', () => {
    expect(isTerminalTabActive('terminal:local::w12.1', 'local', 'ws:w_X.1', 'window', 13)).toBe(false);
    expect(isTerminalTabActive('terminal:local::w12.1', 'other', 'ws:w_X.1', 'window', 12)).toBe(false);
    expect(isTerminalTabActive('terminal:local::w12.1', 'local', 'ws:w_X.1', 'window')).toBe(false);
  });

  it('keeps the exact legacy comparison for legacy tab ids', () => {
    expect(isTerminalTabActive('terminal:local/main:win.1', 'local', 'main:win.1', 'window', 12)).toBe(true);
    expect(isTerminalTabActive('terminal:local/main:win.1', 'local', 'main:win.2', 'window', 12)).toBe(false);
  });

  it('is false without an active tab', () => {
    expect(isTerminalTabActive(null, 'local', 'main:win.1', 'window', 12)).toBe(false);
  });
});
