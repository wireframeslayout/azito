import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';

const TMUX_CAPS = { changeEvents: true, agentState: false, independentClients: true, copyMode: true };

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'srv', type: 'local', host: null, agentPort: null, agentToken: null, agentVersion: null, sshHost: null,
    sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
    isolationCleanupReport: null, defaultMux: 'tmux', muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z', ...overrides,
  };
}

function makeOpts(stored: ServerConfig | null, registerMisao = false): ServersRouteOptions {
  const serverRepo = {
    findAll: vi.fn(() => []), findByName: vi.fn(() => stored), create: vi.fn(), update: vi.fn(),
    updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(), clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(),
    findMetaByNames: vi.fn(() => []), updateIsolationReport: vi.fn(), updateIsolationCleanupReport: vi.fn(),
    updateIsolationVerification: vi.fn(), updateIsolationFailure: vi.fn(), delete: vi.fn(),
  } as IServerRepository;
  const muxDriverRegistry = new MuxDriverRegistry();
  muxDriverRegistry.register('tmux', { kind: 'tmux', caps: TMUX_CAPS } as unknown as IMuxClient);
  if (registerMisao) muxDriverRegistry.register('misao', { kind: 'misao', caps: TMUX_CAPS } as unknown as IMuxClient);
  return {
    serverRepo,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    tmux: {} as ServersRouteOptions['tmux'],
    transportFactory: { invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry,
    misaoDaemonStatus: vi.fn(async () => ({ installed: false, detail: 'daemon_unreachable' })),
  };
}

async function buildApp(opts: ServersRouteOptions) {
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

const LOCAL_ONLY = { error: 'defaultMux "misao" is only supported on local servers' };

describe('POST /api/servers with defaultMux', () => {
  it('creates a local misao server', async () => {
    const opts = makeOpts(null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', defaultMux: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.create).toHaveBeenCalledWith('m', 'local', undefined, undefined, undefined, undefined, undefined, undefined, 'misao');
  });

  it('keeps the tmux runtime separate from the default mux', async () => {
    const opts = makeOpts(null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', defaultMux: 'misao', muxRuntime: 'managed' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.create).toHaveBeenCalledWith('m', 'local', undefined, undefined, undefined, undefined, undefined, 'managed', 'misao');
  });

  it('accepts the legacy muxRuntime "misao" as defaultMux "misao"', async () => {
    const opts = makeOpts(null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.create).toHaveBeenCalledWith('m', 'local', undefined, undefined, undefined, undefined, undefined, undefined, 'misao');
  });

  it('rejects unknown values', async () => {
    const opts = makeOpts(null);
    const app = await buildApp(opts);
    const bad = await app.inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', defaultMux: 'zellij' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'defaultMux must be "tmux" or "misao"' });
    const badRuntime = await app.inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', muxRuntime: 'herdr' } });
    expect(badRuntime.json()).toEqual({ error: 'muxRuntime must be "system" or "managed"' });
    expect(opts.serverRepo.create).not.toHaveBeenCalled();
  });

  it.each(['defaultMux', 'muxRuntime'] as const)('rejects an agent misao server (%s)', async (field) => {
    const opts = makeOpts(null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'agent', host: 'h', agentPort: 1, agentToken: 't', [field]: 'misao' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(LOCAL_ONLY);
    expect(opts.serverRepo.create).not.toHaveBeenCalled();
  });

  it('rejects autoInstall with misao', async () => {
    const opts = makeOpts(null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', host: 'u@h', autoInstall: true, defaultMux: 'misao' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(LOCAL_ONLY);
  });
});

describe('PUT /api/servers/:name with defaultMux', () => {
  it('switches the default mux and keeps the stored tmux runtime', async () => {
    const opts = makeOpts(makeServer({ muxRuntime: 'managed' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { defaultMux: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.update).toHaveBeenCalledWith('srv', 'local', undefined, undefined, undefined, undefined, 'managed', 'misao');
  });

  it('changes the tmux runtime without touching the default mux', async () => {
    const opts = makeOpts(makeServer({ defaultMux: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'managed' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.update).toHaveBeenCalledWith('srv', 'local', undefined, undefined, undefined, undefined, 'managed', 'misao');
  });

  it('accepts the legacy muxRuntime "misao" as defaultMux "misao"', async () => {
    const opts = makeOpts(makeServer());
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.update).toHaveBeenCalledWith('srv', 'local', undefined, undefined, undefined, undefined, 'system', 'misao');
  });

  it('rejects the legacy muxRuntime "misao" combined with defaultMux "tmux"', async () => {
    const opts = makeOpts(makeServer());
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'misao', defaultMux: 'tmux' } });
    expect(res.statusCode).toBe(400);
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });

  it('rejects changing a misao server to an agent', async () => {
    const opts = makeOpts(makeServer({ defaultMux: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'agent', host: 'h', agentPort: 1, agentToken: 't' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(LOCAL_ONLY);
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });

  it('allows moving a misao server to an agent in the same request that sets defaultMux "tmux"', async () => {
    const opts = makeOpts(makeServer({ defaultMux: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'agent', host: 'h', agentPort: 1, agentToken: 't', defaultMux: 'tmux' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/servers/:name mux detail', () => {
  it('reports the registry reason when the misao driver is not registered', async () => {
    const opts = makeOpts(makeServer({ defaultMux: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.json().mux).toEqual({
      runtime: 'system', kind: 'misao', driverAvailable: false, caps: null, reason: 'driver_not_registered',
      kinds: [
        { kind: 'misao', driverAvailable: false, caps: null, reason: 'driver_not_registered' },
        { kind: 'tmux', driverAvailable: true, caps: TMUX_CAPS },
      ],
    });
  });

  it('shows the tmux runtime next to the misao kind', async () => {
    const opts = makeOpts(makeServer({ defaultMux: 'misao', muxRuntime: 'managed' }), true);
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.json().mux).toMatchObject({ runtime: 'managed', kind: 'misao', driverAvailable: true, caps: TMUX_CAPS });
  });

  it('lists every mux a local tmux server can host next to its default', async () => {
    const opts = makeOpts(makeServer());
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.json().mux).toEqual({
      runtime: 'system', kind: 'tmux', driverAvailable: true, caps: TMUX_CAPS,
      kinds: [
        { kind: 'tmux', driverAvailable: true, caps: TMUX_CAPS },
        { kind: 'misao', driverAvailable: false, caps: null, reason: 'driver_not_registered' },
      ],
    });
  });

  it('keeps the tmux-only (agent) server detail shape unchanged', async () => {
    const opts = makeOpts(makeServer({ type: 'agent' }), true);
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.json().mux).toEqual({ runtime: 'system', kind: 'tmux', driverAvailable: true, caps: TMUX_CAPS });
  });
});

describe('POST /api/servers/:name/agent/install on a misao server', () => {
  it('rejects before any remote work', async () => {
    const install = vi.fn();
    const opts = { ...makeOpts(makeServer({ defaultMux: 'misao', sshHost: 'u@h' })), agentInstaller: { install } as unknown as ServersRouteOptions['agentInstaller'] };
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers/srv/agent/install' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(LOCAL_ONLY);
    expect(install).not.toHaveBeenCalled();
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });
});

describe('PUT /api/servers/:name onMuxChanged', () => {
  it('reports the previous and next server when the default mux changes', async () => {
    const onMuxChanged = vi.fn();
    const opts = { ...makeOpts(makeServer()), onMuxChanged };
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { defaultMux: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(onMuxChanged).toHaveBeenCalledTimes(1);
    const { previous, next } = onMuxChanged.mock.calls[0][0];
    expect(previous.defaultMux).toBe('tmux');
    expect(next).toMatchObject({ name: 'srv', type: 'local', defaultMux: 'misao', muxRuntime: 'system' });
  });

  it('is also called when only the tmux runtime changes (the cached transport must be dropped)', async () => {
    const onMuxChanged = vi.fn();
    const opts = { ...makeOpts(makeServer()), onMuxChanged };
    await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'managed' } });
    expect(onMuxChanged).toHaveBeenCalledTimes(1);
  });

  it('is not called when nothing about the mux changes', async () => {
    const onMuxChanged = vi.fn();
    const opts = { ...makeOpts(makeServer()), onMuxChanged };
    await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { defaultMux: 'tmux', muxRuntime: 'system' } });
    expect(onMuxChanged).not.toHaveBeenCalled();
  });
});

describe('GET /api/servers/:name/install-status', () => {
  function withTransport(opts: ServersRouteOptions) {
    const exec = vi.fn(async (cmd: string) => ({ stdout: cmd === 'uname -s' ? 'Linux\n' : '', stderr: '', code: 0 }));
    const transportFactory = { invalidate: vi.fn(), getTransport: vi.fn(() => ({ exec })) } as unknown as ServersRouteOptions['transportFactory'];
    return { exec, opts: { ...opts, transportFactory } };
  }

  it('reports the misao daemon for a misao server, and tmux as an optional row (installed or not)', async () => {
    const stored = makeServer({ defaultMux: 'misao' });
    const misaoDaemonStatus = vi.fn(async () => ({ installed: true, version: '0.2.0' }));
    const { opts } = withTransport({ ...makeOpts(stored), misaoDaemonStatus });

    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv/install-status' });

    const body = res.json();
    expect(body.misao).toEqual({ installed: true, version: '0.2.0' });
    expect(body.tmux).toMatchObject({ installed: false, optional: true });
    expect(body).toHaveProperty('node');
  });

  it('adds the misao row to a local tmux server while its daemon serves it', async () => {
    const stored = makeServer();
    const misaoDaemonStatus = vi.fn(async () => ({ installed: true, version: '0.2.0' }));
    const { opts } = withTransport({ ...makeOpts(stored, true), misaoDaemonStatus });

    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv/install-status' });

    expect(res.json()).toHaveProperty('tmux');
    expect(res.json().misao).toEqual({ installed: true, version: '0.2.0', optional: true });
  });

  it('reports an unreachable daemon as not installed', async () => {
    const stored = makeServer({ defaultMux: 'misao' });
    const misaoDaemonStatus = vi.fn(async () => ({ installed: false, detail: 'daemon_unreachable' }));
    const { opts } = withTransport({ ...makeOpts(stored), misaoDaemonStatus });

    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv/install-status' });

    expect(res.json().misao).toEqual({ installed: false, detail: 'daemon_unreachable' });
  });

  it('keeps the tmux check for a tmux server', async () => {
    const stored = makeServer();
    const misaoDaemonStatus = vi.fn();
    const { exec, opts } = withTransport({ ...makeOpts(stored), misaoDaemonStatus });

    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv/install-status' });

    expect(res.json()).toHaveProperty('tmux');
    expect(res.json()).not.toHaveProperty('misao');
    expect(exec).toHaveBeenCalledWith('tmux -V');
    expect(misaoDaemonStatus).not.toHaveBeenCalled();
  });
});
