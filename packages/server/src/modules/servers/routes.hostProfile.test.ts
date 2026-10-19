import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import type { HostProfile } from '../../shared/os/hostProfile';
import { KeyedMutex } from '../../shared/keyedMutex';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';

const TMUX_CAPS = { changeEvents: true, agentState: false, independentClients: true, copyMode: true };
const HUB: HostProfile = { platform: 'darwin', arch: 'arm64' };

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'srv', type: 'agent', host: '100.64.0.7', agentPort: 3002, agentToken: 'tok', agentVersion: 'v1', sshHost: null,
    hostProfile: null, sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
    isolationCleanupReport: null, defaultMux: 'tmux', muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z', ...overrides,
  };
}

function makeOpts(servers: ServerConfig[]): ServersRouteOptions {
  const serverRepo = {
    findAll: vi.fn(() => servers), findByName: vi.fn((name: string) => servers.find((s) => s.name === name) ?? null), create: vi.fn(), update: vi.fn(),
    updateAgentVersion: vi.fn(), updateHostProfile: vi.fn(), updateFingerprint: vi.fn(), clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(),
    findMetaByNames: vi.fn(() => []), updateIsolationReport: vi.fn(), updateIsolationCleanupReport: vi.fn(),
    updateIsolationVerification: vi.fn(), updateIsolationFailure: vi.fn(), delete: vi.fn(),
  } as IServerRepository;
  const muxDriverRegistry = new MuxDriverRegistry();
  muxDriverRegistry.register('tmux', { kind: 'tmux', caps: TMUX_CAPS } as unknown as IMuxClient);
  return {
    serverRepo,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    agentHostRecorder: { recordIfUnknown: vi.fn(async () => null), record: vi.fn(async () => null) } as unknown as ServersRouteOptions['agentHostRecorder'],
    tmux: {} as ServersRouteOptions['tmux'],
    // A local server's host is the hub's own (here macOS arm64); an agent server's is what is recorded for it.
    transportFactory: {
      invalidate: vi.fn(),
      hostProfileFor: (server: Pick<ServerConfig, 'type' | 'hostProfile'>) => (server.type === 'local' ? HUB : server.hostProfile),
    } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry,
    misaoDaemonStatus: vi.fn(async () => ({ installed: false })),
  };
}

async function buildApp(opts: ServersRouteOptions) {
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

describe('server host profile in the API', () => {
  const servers = [
    makeServer({ name: 'hub', type: 'local', host: null, agentPort: null, agentToken: null }),
    makeServer({ name: 'mac', hostProfile: { platform: 'darwin', arch: 'x64' } }),
    makeServer({ name: 'old' }),
  ];

  it('lists hostProfile (camelCase) apart from host: the hub\'s own for local, the recorded one for an agent, null when unknown', async () => {
    const res = await (await buildApp(makeOpts(servers))).inject({ method: 'GET', url: '/api/servers' });
    const byName = Object.fromEntries((res.json() as Array<{ name: string }>).map((s) => [s.name, s]));
    expect(byName.hub).toMatchObject({ hostProfile: HUB, host: null });
    expect(byName.mac).toMatchObject({ hostProfile: { platform: 'darwin', arch: 'x64' }, host: '100.64.0.7' });
    expect(byName.old).toMatchObject({ hostProfile: null, host: '100.64.0.7' });
  });

  it('returns it in the detail too', async () => {
    const app = await buildApp(makeOpts(servers));
    expect((await app.inject({ method: 'GET', url: '/api/servers/mac' })).json()).toMatchObject({ hostProfile: { platform: 'darwin', arch: 'x64' } });
    expect((await app.inject({ method: 'GET', url: '/api/servers/hub' })).json()).toMatchObject({ hostProfile: HUB });
    expect((await app.inject({ method: 'GET', url: '/api/servers/old' })).json()).toMatchObject({ hostProfile: null });
  });
});

describe('PUT /api/servers/:name and the recorded host', () => {
  const recorded = makeServer({ name: 'mac', hostProfile: { platform: 'linux', arch: 'x64' } });

  it('forgets the host when the agent is pointed at another address, so it is read again from the new machine', async () => {
    const opts = makeOpts([recorded]);
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/mac', payload: { host: '100.64.0.99' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateHostProfile).toHaveBeenCalledWith('mac', null);
  });

  it('forgets it when the port or the type changes', async () => {
    const portOpts = makeOpts([recorded]);
    await (await buildApp(portOpts)).inject({ method: 'PUT', url: '/api/servers/mac', payload: { agentPort: 4000 } });
    expect(portOpts.serverRepo.updateHostProfile).toHaveBeenCalledWith('mac', null);

    const typeOpts = makeOpts([recorded]);
    await (await buildApp(typeOpts)).inject({ method: 'PUT', url: '/api/servers/mac', payload: { type: 'local' } });
    expect(typeOpts.serverRepo.updateHostProfile).toHaveBeenCalledWith('mac', null);
  });

  it('keeps it when only the token or the mux settings change (same machine)', async () => {
    const opts = makeOpts([recorded]);
    const app = await buildApp(opts);
    await app.inject({ method: 'PUT', url: '/api/servers/mac', payload: { agentToken: 'new-token' } });
    await app.inject({ method: 'PUT', url: '/api/servers/mac', payload: { muxRuntime: 'managed' } });
    await app.inject({ method: 'PUT', url: '/api/servers/mac', payload: { host: '100.64.0.7' } });
    expect(opts.serverRepo.updateHostProfile).not.toHaveBeenCalled();
  });
});

describe('POST /api/servers/:name/install-agent and the recorded host', () => {
  it('stores the host the preflight read when the agent is reinstalled', async () => {
    const install = vi.fn(async () => ({ success: true, host: '100.64.0.9', port: 3002, token: 'tok2', version: 'v2', startMethod: 'systemd', steps: [], hostProfile: { platform: 'linux', arch: 'x64' } }));
    const opts = { ...makeOpts([makeServer({ name: 'mac', sshHost: 'u@mac' })]), agentInstaller: { install } as unknown as ServersRouteOptions['agentInstaller'] };
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers/mac/agent/install' });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateHostProfile).toHaveBeenCalledWith('mac', { platform: 'linux', arch: 'x64' });
  });
});
