import { describe, it, expect, vi } from 'vitest';
import { formatMuxRef, type MuxRef } from '@azito/shared';
import { isRefKindCompatible, killWindowCore, resolveRefForServer } from './windowPaneOps';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { Window, IWindowRepository } from './Window';

const TMUX_REF: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
const MISAO_REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

describe('isRefKindCompatible', () => {
  it('matches the ref kind against the server runtime', () => {
    expect(isRefKindCompatible(TMUX_REF, { defaultMux: 'tmux' as const })).toBe(true);
    expect(isRefKindCompatible(TMUX_REF, { defaultMux: 'tmux' as const })).toBe(true);
    expect(isRefKindCompatible(MISAO_REF, { defaultMux: 'tmux' as const })).toBe(false);
    expect(isRefKindCompatible(MISAO_REF, { defaultMux: 'misao' as const })).toBe(true);
    expect(isRefKindCompatible(TMUX_REF, { defaultMux: 'misao' as const })).toBe(false);
  });

  it('accepts only tmux refs when the server is unknown', () => {
    expect(isRefKindCompatible(TMUX_REF, null)).toBe(true);
    expect(isRefKindCompatible(MISAO_REF, undefined)).toBe(false);
  });
});

describe('resolveRefForServer', () => {
  it('returns a compatible ref', () => {
    expect(resolveRefForServer(encodeURIComponent(formatMuxRef(TMUX_REF)), { defaultMux: 'tmux' as const })).toEqual(TMUX_REF);
  });

  it('rejects a misao ref on a tmux server with a 400', () => {
    try {
      resolveRefForServer(encodeURIComponent(formatMuxRef(MISAO_REF)), { defaultMux: 'tmux' as const });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe('Invalid ref parameter');
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});

describe('killWindowCore with a misao window', () => {
  const server = { name: 'local', type: 'local', defaultMux: 'misao' as const } as ServerConfig;
  const ok = { stdout: '', stderr: '', code: 0 };

  it('closes an unregistered window and succeeds (no tmux target is derived from the misao ref)', async () => {
    const closeWindow = vi.fn(async () => ok);
    const removeByServerAndTarget = vi.fn(() => 1);
    const notifySessionsChanged = vi.fn();

    const result = await killWindowCore(
      { muxClient: { closeWindow } as unknown as IMuxClient, windowRepo: { removeByServerAndTarget } as unknown as IWindowRepository, notifySessionsChanged },
      server, MISAO_REF, undefined,
    );

    expect(result.ok).toBe(true);
    expect(closeWindow).toHaveBeenCalledWith(server, MISAO_REF);
    expect(removeByServerAndTarget).toHaveBeenCalledWith('local', `ws:${MISAO_REF.window}`);
    expect(notifySessionsChanged).toHaveBeenCalledWith('local');
  });

  it('hands a primary task window to destroyPrimaryTaskWindow under its window id, not the tmux_target form', async () => {
    const dbWindow = { id: 3, taskId: 9, isPrimary: true, ownerType: 'task', tmuxTarget: 'renamed:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8', muxRef: MISAO_REF } as unknown as Window;
    const destroyPrimaryTaskWindow = vi.fn(async () => ({ success: true, alreadyGone: false, result: ok }));

    await killWindowCore(
      { muxClient: { closeWindow: vi.fn(async () => ok) } as unknown as IMuxClient, windowRepo: {} as IWindowRepository, destroyPrimaryTaskWindow, notifySessionsChanged: vi.fn() },
      server, MISAO_REF, dbWindow,
    );

    expect(destroyPrimaryTaskWindow).toHaveBeenCalledWith(9, MISAO_REF.window, 'local', dbWindow.tmuxTarget, 'window_killed_via_window_route', expect.any(Function), expect.any(Function));
  });
});
