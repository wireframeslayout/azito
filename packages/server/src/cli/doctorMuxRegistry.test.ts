import { describe, expect, it, vi } from 'vitest';
import { MuxDriverRegistry } from '../modules/tmux/MuxDriverRegistry';
import type { IMuxClient } from '../modules/tmux/IMuxClient';
import type { ServerConfig } from '../modules/servers/Server';
import { probeWindowLiveness, type DoctorMux } from './doctorMuxRegistry';

const server = { name: 'local', type: 'local', defaultMux: 'misao' } as ServerConfig;
const MISAO_REF = JSON.stringify({ kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' });

function setup(drivers: { tmux?: Partial<IMuxClient>; misao?: Partial<IMuxClient>; misaoAvailable?: boolean }) {
  const registry = new MuxDriverRegistry();
  registry.register('tmux', { kind: 'tmux', ...drivers.tmux } as IMuxClient);
  registry.register('misao', { kind: 'misao', ...drivers.misao } as IMuxClient, () => (
    drivers.misaoAvailable === false ? { available: false, reason: 'daemon_unreachable' } : { available: true }
  ));
  const connectMisao = vi.fn(async () => undefined);
  const mux: DoctorMux = { registry, connectMisao, close: vi.fn() };
  return { mux, connectMisao };
}

describe('probeWindowLiveness', () => {
  it('asks tmux about a window without a ref, by its target, and never connects to the misao daemon', async () => {
    const probePane = vi.fn(async () => ({ alive: true, verified: true }));
    const { mux, connectMisao } = setup({ tmux: { probePane } });

    expect(await probeWindowLiveness(mux, server, { tmuxTarget: 'sess:win', muxRef: null })).toEqual({ alive: true, verified: true });
    expect(probePane).toHaveBeenCalledWith(server, 'sess:win');
    expect(connectMisao).not.toHaveBeenCalled();
  });

  it('asks the misao driver about a misao window: alive while any of its panes runs', async () => {
    const probePane = vi.fn()
      .mockResolvedValueOnce({ alive: false, verified: true })
      .mockResolvedValueOnce({ alive: true, verified: true });
    const { mux, connectMisao } = setup({
      misao: {
        windowExists: vi.fn(async () => true),
        listPanesByRef: vi.fn(async () => [{ handle: 'p_1' }, { handle: 'p_2' }]) as never,
        probePane,
      },
    });

    expect(await probeWindowLiveness(mux, server, { tmuxTarget: 'ws:w_x', muxRef: MISAO_REF })).toEqual({ alive: true, verified: true });
    expect(connectMisao).toHaveBeenCalledTimes(1);
  });

  it('reports a misao window the daemon does not list as verified gone', async () => {
    const { mux } = setup({ misao: { windowExists: vi.fn(async () => false) } });
    expect(await probeWindowLiveness(mux, server, { tmuxTarget: 'ws:w_x', muxRef: MISAO_REF })).toEqual({ alive: false, verified: true });
  });

  it('never reads an unreachable daemon as a window that is gone', async () => {
    const { mux } = setup({ misaoAvailable: false });
    expect(await probeWindowLiveness(mux, server, { tmuxTarget: 'ws:w_x', muxRef: MISAO_REF })).toEqual({ alive: false, verified: false });
  });

  it('reports a daemon that fails mid-probe as unverified', async () => {
    const { mux } = setup({ misao: { windowExists: vi.fn(async () => { throw new Error('socket closed'); }) } });
    expect(await probeWindowLiveness(mux, server, { tmuxTarget: 'ws:w_x', muxRef: MISAO_REF })).toEqual({ alive: false, verified: false });
  });

  it('is not verified when no pane of a not-running window could be confirmed', async () => {
    const { mux } = setup({
      misao: {
        windowExists: vi.fn(async () => true),
        listPanesByRef: vi.fn(async () => [{ handle: 'p_1' }]) as never,
        probePane: vi.fn(async () => ({ alive: false, verified: false })),
      },
    });
    expect(await probeWindowLiveness(mux, server, { tmuxTarget: 'ws:w_x', muxRef: MISAO_REF })).toEqual({ alive: false, verified: false });
  });
});
