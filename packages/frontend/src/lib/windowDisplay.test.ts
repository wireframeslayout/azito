import { describe, expect, it } from 'vitest';
import { formatMuxRef } from '@azito/shared';
import { sessionWindowLabel, misaoRefWindowTitle } from './windowDisplay';

const MISAO_WINDOW = 'w_0123456789ABCDEFGHJKMNPQRS';

describe('sessionWindowLabel', () => {
  it('shows only the window name for a misao window', () => {
    const ref = formatMuxRef({ kind: 'misao', workspace: 'default', window: MISAO_WINDOW });
    expect(sessionWindowLabel('default', { name: 'default', ref })).toBe('default');
  });

  it('keeps session:window for a tmux window', () => {
    const ref = formatMuxRef({ kind: 'tmux', workspace: 'azito', window: 'win--abc' });
    expect(sessionWindowLabel('azito', { name: 'win--abc', ref })).toBe('azito:win--abc');
  });
});


describe('misaoRefWindowTitle', () => {
  const ref = JSON.stringify({ kind: 'misao', workspace: 'dev', window: 'w_01234567890123456789012345' });
  const sessions = [{ name: 'dev', windows: [{ name: 'Editor', ref, index: 1, windowId: null, panes: [] }] }];
  it('resolves a ref after sessions arrive, and hides unmatched IDs', () => {
    expect(misaoRefWindowTitle([], ref, 1, 'Window')).toBe('Window');
    expect(misaoRefWindowTitle(sessions, ref, 1, 'Window')).toBe('Editor');
    expect(misaoRefWindowTitle(sessions, 'different', 1, 'Window')).toBe('Window');
  });
});
