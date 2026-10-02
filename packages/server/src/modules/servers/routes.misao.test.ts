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
    isolationCleanupReport: null, muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z', ...overrides,
  };
}

function makeOpts(misaoEnabled: boolean | undefined, stored: ServerConfig | null): ServersRouteOptions {
  const serverRepo = {
    findAll: vi.fn(() => []), findByName: vi.fn(() => stored), create: vi.fn(), update: vi.fn(),
    updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(), clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(),
    findMetaByNames: vi.fn(() => []), updateIsolationReport: vi.fn(), updateIsolationCleanupReport: vi.fn(),
    updateIsolationVerification: vi.fn(), updateIsolationFailure: vi.fn(), delete: vi.fn(),
  } as IServerRepository;
  const muxDriverRegistry = new MuxDriverRegistry({ misaoEnabled });
  muxDriverRegistry.register('tmux', { kind: 'tmux', caps: TMUX_CAPS } as unknown as IMuxClient);
  return {
    misaoEnabled,
    serverRepo,
    tmux: {} as ServersRouteOptions['tmux'],
    transportFactory: { invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry,
  };
}

async function buildApp(opts: ServersRouteOptions) {
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

describe('servers routes with the misao flag off', () => {
  it('rejects creating a misao server with the unchanged error text', async () => {
    const opts = makeOpts(false, null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'muxRuntime must be "system" or "managed"' });
    expect(opts.serverRepo.create).not.toHaveBeenCalled();
  });

  it('rejects switching a server to misao', async () => {
    const opts = makeOpts(undefined, makeServer());
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'muxRuntime must be "system" or "managed"' });
  });

  it('shows an existing misao row as driverAvailable:false / misao_disabled', async () => {
    const opts = makeOpts(false, makeServer({ muxRuntime: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mux).toEqual({ runtime: 'misao', kind: 'misao', driverAvailable: false, caps: null, reason: 'misao_disabled' });
  });

  it('allows moving a misao row back to system', async () => {
    const opts = makeOpts(false, makeServer({ muxRuntime: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'system' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.update).toHaveBeenCalledWith('srv', 'local', undefined, undefined, undefined, undefined, 'system');
  });

  it('refuses other edits that would keep the row on misao', async () => {
    const opts = makeOpts(false, makeServer({ muxRuntime: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { sshHost: 'u@h' } });
    expect(res.statusCode).toBe(400);
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });

  it('keeps the tmux server detail shape unchanged', async () => {
    const opts = makeOpts(false, makeServer());
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.json().mux).toEqual({ runtime: 'system', kind: 'tmux', driverAvailable: true, caps: TMUX_CAPS });
  });
});

describe('servers routes with the misao flag on', () => {
  it('creates a local misao server', async () => {
    const opts = makeOpts(true, null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'local', muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.create).toHaveBeenCalledWith('m', 'local', undefined, undefined, undefined, undefined, undefined, 'misao');
  });

  it('rejects an agent misao server', async () => {
    const opts = makeOpts(true, null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', type: 'agent', host: 'h', agentPort: 1, agentToken: 't', muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(400);
    expect(opts.serverRepo.create).not.toHaveBeenCalled();
  });

  it('rejects autoInstall with misao', async () => {
    const opts = makeOpts(true, null);
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers', payload: { name: 'm', host: 'u@h', autoInstall: true, muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects changing a misao server to an agent', async () => {
    const opts = makeOpts(true, makeServer({ muxRuntime: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'agent', host: 'h', agentPort: 1, agentToken: 't' } });
    expect(res.statusCode).toBe(400);
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });

  it('reports driver_not_registered while the misao driver is not implemented', async () => {
    const opts = makeOpts(true, makeServer({ muxRuntime: 'misao' }));
    const res = await (await buildApp(opts)).inject({ method: 'GET', url: '/api/servers/srv' });
    expect(res.json().mux).toEqual({ runtime: 'misao', kind: 'misao', driverAvailable: false, caps: null, reason: 'driver_not_registered' });
  });
});

describe('POST /api/servers/:name/agent/install on a misao server', () => {
  it.each([false, true])('rejects before any remote work (misaoEnabled=%s)', async (misaoEnabled) => {
    const install = vi.fn();
    const opts = { ...makeOpts(misaoEnabled, makeServer({ muxRuntime: 'misao', sshHost: 'u@h' })), agentInstaller: { install } as unknown as ServersRouteOptions['agentInstaller'] };
    const res = await (await buildApp(opts)).inject({ method: 'POST', url: '/api/servers/srv/agent/install' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'muxRuntime "misao" is only supported on local servers' });
    expect(install).not.toHaveBeenCalled();
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });
});

describe('PUT /api/servers/:name onMuxRuntimeChanged', () => {
  it('reports the previous and next server when the runtime changes', async () => {
    const onMuxRuntimeChanged = vi.fn();
    const opts = { ...makeOpts(true, makeServer()), onMuxRuntimeChanged };
    const res = await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'misao' } });
    expect(res.statusCode).toBe(200);
    expect(onMuxRuntimeChanged).toHaveBeenCalledTimes(1);
    const { previous, next } = onMuxRuntimeChanged.mock.calls[0][0];
    expect(previous.muxRuntime).toBe('system');
    expect(next).toMatchObject({ name: 'srv', type: 'local', muxRuntime: 'misao' });
  });

  it('is not called when the runtime stays the same', async () => {
    const onMuxRuntimeChanged = vi.fn();
    const opts = { ...makeOpts(true, makeServer()), onMuxRuntimeChanged };
    await (await buildApp(opts)).inject({ method: 'PUT', url: '/api/servers/srv', payload: { muxRuntime: 'system' } });
    expect(onMuxRuntimeChanged).not.toHaveBeenCalled();
  });
});
