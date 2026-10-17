import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { checkTmuxStatus, describeDefaultMuxProblem, misaoStatusItem } from './muxStatus';

const local = (defaultMux: 'tmux' | 'misao'): ServerConfig => ({
  name: 'local', type: 'local', host: null, agentPort: null, agentToken: null, agentVersion: null, sshHost: null,
  sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
  isolationCleanupReport: null, defaultMux, muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z',
});

async function statusOf(server: ServerConfig, exec: () => Promise<{ stdout: string; stderr: string; code: number }>, misao: ServersRouteOptions['misaoDaemonStatus']) {
  const opts: ServersRouteOptions = {
    serverRepo: { findByName: () => server, findAll: () => [] } as unknown as IServerRepository,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    misaoDaemonStatus: misao,
    tmux: {} as ServersRouteOptions['tmux'],
    transportFactory: { getTransport: () => ({ exec }), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry: new MuxDriverRegistry(),
  };
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return (await app.inject({ method: 'GET', url: '/api/servers/local/status' })).json();
}

describe('GET /api/servers/:name/status is per mux', () => {
  it('reports a misao-only host as online without a problem even though tmux is not installed', async () => {
    const tmuxMissing = async () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }); };
    const body = await statusOf(local('misao'), tmuxMissing, async () => ({ installed: true, version: '0.3.0', daemonVersion: '0.2.0' }));

    expect(body.status).toBe('online');
    expect(body.mux.misao).toEqual({ available: true, version: '0.2.0' });
    expect(body.mux.tmux).toMatchObject({ available: false });
    expect(body.message).toBeUndefined();
  });

  it('says what is wrong when the default mux itself is down', async () => {
    const body = await statusOf(local('misao'), async () => ({ stdout: 'tmux 3.4', stderr: '', code: 0 }), async () => ({ installed: false, detail: 'daemon_unreachable' }));

    expect(body.status).toBe('online');
    expect(body.mux.tmux).toEqual({ available: true, version: 'tmux 3.4' });
    expect(body.mux.misao).toEqual({ available: false, detail: 'daemon_unreachable' });
    expect(body.message).toBe('misao: daemon_unreachable');
  });

  it('keeps a tmux-default host on tmux: a missing tmux is the problem, an absent misao daemon is not', async () => {
    const body = await statusOf(local('tmux'), async () => ({ stdout: '', stderr: 'tmux: not found', code: 127 }), async () => ({ installed: false, detail: 'daemon_unreachable' }));

    expect(body.message).toBe('tmux not found');
    expect(body.mux.tmux.available).toBe(false);
  });
});

describe('muxStatus helpers', () => {
  it('runs the managed tmux binary for a managed runtime', async () => {
    const exec = vi.fn(async () => ({ stdout: 'tmux 3.5\n', stderr: '', code: 0 }));
    expect(await checkTmuxStatus({ exec }, 'managed')).toEqual({ available: true, version: 'tmux 3.5' });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('$HOME/.azito/tmux/bin/tmux'));
  });

  it('turns an exec failure into a status instead of throwing', async () => {
    const status = await checkTmuxStatus({ exec: async () => { throw new Error('connection reset'); } }, 'system');
    expect(status).toEqual({ available: false, detail: 'connection reset' });
  });

  it('maps a daemon check to a status entry', () => {
    expect(misaoStatusItem({ installed: true })).toEqual({ available: true });
    expect(misaoStatusItem({ installed: false, detail: 'protocol_incompatible' })).toEqual({ available: false, detail: 'protocol_incompatible' });
  });

  it('has no problem to report while the default mux answers', () => {
    expect(describeDefaultMuxProblem({ type: 'local', defaultMux: 'misao' }, { misao: { available: true }, tmux: { available: false } })).toBeUndefined();
  });
});
