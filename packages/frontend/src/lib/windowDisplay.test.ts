import { describe, expect, it } from 'vitest';
import { formatMuxRef } from '@azito/shared';
import { sessionWindowLabel } from './windowDisplay';

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
