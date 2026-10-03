import { describe, it, expect, vi } from 'vitest';
import { formatMuxRef, type MuxRef } from '@azito/shared';
import { resolveTerminalTarget, type TerminalTargetParams } from './resolveTerminalTarget';
import type { ServerConfig } from '../modules/servers/Server';
import type { Window } from '../modules/windows/Window';

const TMUX_REF: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
const MISAO_REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

const servers: Record<string, ServerConfig> = {
  tmuxsrv: { name: 'tmuxsrv', muxRuntime: 'system' } as ServerConfig,
  misaosrv: { name: 'misaosrv', muxRuntime: 'misao' } as ServerConfig,
};
const windows: Record<number, Window> = {
  7: { id: 7, serverName: 'tmuxsrv', tmuxTarget: 'sess:win', muxRef: TMUX_REF } as Window,
};
const resolveDriverRef = vi.fn(async (_server: ServerConfig, target: string): Promise<MuxRef | null> => (target === 'ws:win' || target === `ws:${MISAO_REF.window}` ? MISAO_REF : null));
const deps = {
  resolveDriverRef,
  serverRepo: { findByName: (name: string) => servers[name] ?? null },
  windowRepo: { findById: (id: number) => windows[id] },
};
const params = (p: Partial<TerminalTargetParams>): TerminalTargetParams => ({ serverName: null, windowId: null, ref: null, target: null, ...p });
const encoded = (ref: MuxRef) => encodeURIComponent(formatMuxRef(ref));

describe('resolveTerminalTarget', () => {
  it('accepts a ref whose kind matches the server', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: encoded(TMUX_REF) }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('rejects a misao ref on a tmux server', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: encoded(MISAO_REF) }), deps)).toBeNull();
  });

  it('rejects a tmux ref on a misao server', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', ref: encoded(TMUX_REF) }), deps)).toBeNull();
  });

  it('rejects a ref when the server is unknown', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'nope', ref: encoded(TMUX_REF) }), deps)).toBeNull();
  });

  it('rejects an unparseable ref', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', ref: 'not-json' }), deps)).toBeNull();
  });

  it('resolves by windowId to the window server and ref', async () => {
    expect(await resolveTerminalTarget(params({ windowId: '7' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('falls back to the tmux target', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'tmuxsrv', target: 'sess:win.1' }), deps)).toEqual({ server: servers.tmuxsrv, ref: TMUX_REF });
  });

  it('resolves a target on a misao server through the driver, not as a tmux target', async () => {
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: 'ws:win.1' }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: `ws:${MISAO_REF.window}` }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: `ws:${MISAO_REF.window}.2` }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: 'ws:other' }), deps)).toBeNull();
    expect(await resolveTerminalTarget(params({ serverName: 'misaosrv', target: 'ws:win' }), deps)).toEqual({ server: servers.misaosrv, ref: MISAO_REF });
    expect(resolveDriverRef).toHaveBeenCalledWith(servers.misaosrv, 'ws:win');
  });

  it('does not consult the driver for a tmux target', async () => {
    resolveDriverRef.mockClear();
    await resolveTerminalTarget(params({ serverName: 'tmuxsrv', target: 'sess:win' }), deps);
    expect(resolveDriverRef).not.toHaveBeenCalled();
  });
});
