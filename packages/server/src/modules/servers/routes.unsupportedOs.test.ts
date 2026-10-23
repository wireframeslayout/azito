import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import type { HostProfile } from '../../shared/os/hostProfile';
import { KeyedMutex } from '../../shared/keyedMutex';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';
import { TmuxInstaller } from './agent-deploy/TmuxInstaller';
import { HarnessInstaller } from './agent-deploy/HarnessInstaller';
import type { SshClient } from './ssh/SshClient';
import { mapAppError } from '../../app/mapAppError';

const TMUX_CAPS = { changeEvents: true, agentState: false, independentClients: true, copyMode: true };

function makeServer(hostProfile: HostProfile | null): ServerConfig {
  return {
    name: 'srv', type: 'agent', host: '100.64.0.7', agentPort: 3002, agentToken: 'tok', agentVersion: 'v1', sshHost: 'user@host',
    hostProfile, sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
    isolationCleanupReport: null, defaultMux: 'tmux', muxRuntime: 'managed', createdAt: '2026-01-01T00:00:00Z',
  };
}

async function buildApp(hostProfile: HostProfile | null) {
  const server = makeServer(hostProfile);
  const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
  const serverRepo = { findAll: () => [server], findByName: (name: string) => (name === server.name ? server : null) } as unknown as IServerRepository;
  const muxDriverRegistry = new MuxDriverRegistry();
  muxDriverRegistry.register('tmux', { kind: 'tmux', caps: TMUX_CAPS } as unknown as IMuxClient);
  const opts = {
    serverRepo,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    agentHostRecorder: { recordIfUnknown: vi.fn(async () => null), record: vi.fn(async () => null), forget: vi.fn() },
    tmux: {},
    transportFactory: {
      invalidate: vi.fn(),
      hostProfileFor: (s: Pick<ServerConfig, 'hostProfile'>) => s.hostProfile,
      getTransport: () => ({ hostProfile, exec, run: vi.fn() }),
    },
    tmuxInstaller: new TmuxInstaller(),
    harnessInstaller: new HarnessInstaller({} as SshClient),
    windowRepo: { findByServer: vi.fn(() => []) },
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry,
    misaoDaemonStatus: vi.fn(async () => ({ installed: false })),
  } as unknown as ServersRouteOptions;
  const app = Fastify();
  // As in app/buildServer.ts: a domain error with its own answer is mapped before the default handler.
  const defaultHandler = app.errorHandler;
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapAppError(err);
    if (mapped) return reply.status(mapped.status).send(mapped.body);
    return defaultHandler.call(app, err, request, reply);
  });
  await app.register(serversRoutes, opts);
  return { app, exec };
}

describe('Unix-only install operations on a Windows server answer unsupported_os with the reason', () => {
  const win32: HostProfile = { platform: 'win32', arch: 'x64' };

  it.each([
    ['install-tmux', 'installing tmux'],
    ['install-browser-runtime', 'installing the browser runtime'],
    ['apply-tmux-config', 'applying the tmux config'],
    ['harness/install', 'installing the harness'],
  ])('POST /api/servers/:name/%s is 501 with the reason in error and the code', async (route, operation) => {
    const { app, exec } = await buildApp(win32);
    const res = await app.inject({ method: 'POST', url: `/api/servers/srv/${route}`, payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'unsupported_os', error: expect.stringContaining(operation) });
    expect(res.json().error).toContain('win32');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a server with no recorded OS (a Unix agent from before it was kept) still applies the tmux config', async () => {
    const { app, exec } = await buildApp(null);
    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/apply-tmux-config' });
    expect(res.statusCode).toBe(200);
    expect(exec).toHaveBeenCalled();
  });
});

describe('branch search on a Windows server answers unsupported_os (the repository API is closed until #370)', () => {
  it('GET /api/servers/:name/branches is 501 with the reason', async () => {
    const { app, exec } = await buildApp({ platform: 'win32', arch: 'x64' });
    const res = await app.inject({ method: 'GET', url: '/api/servers/srv/branches?working_directory=C:%5Cwork' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'unsupported_os', error: expect.stringContaining('win32') });
    expect(exec).not.toHaveBeenCalled();
  });

  it('a Linux server is not refused', async () => {
    const { app } = await buildApp({ platform: 'linux', arch: 'x64' });
    const res = await app.inject({ method: 'GET', url: '/api/servers/srv/branches' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branches: [] });
  });
});
