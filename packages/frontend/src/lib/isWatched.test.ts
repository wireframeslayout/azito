import { describe, expect, it } from 'vitest';
import { isWatchedWindow } from './isWatched';
import { terminalTabId } from './terminalRef';
import { activityKey } from './finishedWindows';

describe('isWatchedWindow', () => {
  it('requires browser focus and the same server for terminal tabs', () => {
    const tab = 'terminal:alpha/session:window.1';
    expect(isWatchedWindow(true, tab, null, 'alpha', 'session:window.2')).toBe(true);
    expect(isWatchedWindow(true, tab, null, 'beta', 'session:window.2')).toBe(false);
    expect(isWatchedWindow(false, tab, null, 'alpha', 'session:window.2')).toBe(false);
  });
  it('matches a window ID and a focused target', () => {
    const tab = terminalTabId({ kind: 'windowId', serverName: 'alpha', windowId: 7, pane: 1 });
    expect(isWatchedWindow(true, tab, null, 'alpha', 'session:window', 7)).toBe(true);
    expect(isWatchedWindow(true, tab, null, 'alpha', 'session:window', 8)).toBe(false);
    expect(isWatchedWindow(true, null, activityKey('alpha', 'session:window', 7), 'alpha', 'session:window', 7)).toBe(true);
  });
});
