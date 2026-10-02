import { describe, it, expect } from 'vitest';
import { formatMuxRef, type MuxRef } from '@azito/shared';
import { isRefKindCompatible, resolveRefForServer } from './windowPaneOps';

const TMUX_REF: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
const MISAO_REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

describe('isRefKindCompatible', () => {
  it('matches the ref kind against the server runtime', () => {
    expect(isRefKindCompatible(TMUX_REF, { muxRuntime: 'system' })).toBe(true);
    expect(isRefKindCompatible(TMUX_REF, { muxRuntime: 'managed' })).toBe(true);
    expect(isRefKindCompatible(MISAO_REF, { muxRuntime: 'system' })).toBe(false);
    expect(isRefKindCompatible(MISAO_REF, { muxRuntime: 'misao' })).toBe(true);
    expect(isRefKindCompatible(TMUX_REF, { muxRuntime: 'misao' })).toBe(false);
  });

  it('accepts only tmux refs when the server is unknown', () => {
    expect(isRefKindCompatible(TMUX_REF, null)).toBe(true);
    expect(isRefKindCompatible(MISAO_REF, undefined)).toBe(false);
  });
});

describe('resolveRefForServer', () => {
  it('returns a compatible ref', () => {
    expect(resolveRefForServer(encodeURIComponent(formatMuxRef(TMUX_REF)), { muxRuntime: 'system' })).toEqual(TMUX_REF);
  });

  it('rejects a misao ref on a tmux server with a 400', () => {
    try {
      resolveRefForServer(encodeURIComponent(formatMuxRef(MISAO_REF)), { muxRuntime: 'system' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe('Invalid ref parameter');
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});
