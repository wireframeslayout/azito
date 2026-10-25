import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import type { HostProfile } from '../../shared/os/hostProfile';
import { KeyedMutex } from '../../shared/keyedMutex';
import type { HarnessInstaller } from './agent-deploy/HarnessInstaller';

const HUB_URL = 'http://hub.test:3001';

function makeServer(type: ServerConfig['type'], hostProfile: HostProfile | null): ServerConfig {
  return {
    name: 'srv', type, host: '100.64.0.7', agentPort: 3002, agentToken: 'tok', agentVersion: 'v1', sshHost: 'user@host',
    hostProfile, sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
    isolationCleanupReport: null, defaultMux: 'tmux', muxRuntime: 'managed', createdAt: '2026-01-01T00:00:00Z',
  };
}

type InstallMethod = 'installLocal' | 'installOnAgent' | 'install';

async function buildApp(server: ServerConfig) {
  const ok = { success: true, steps: [] };
  const harnessInstaller = { installLocal: vi.fn(async () => ok), installOnAgent: vi.fn(async () => ok), install: vi.fn(async () => ok) };
  const opts = {
    serverRepo: { findAll: () => [server], findByName: (name: string) => (name === server.name ? server : null) } as unknown as IServerRepository,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    transportFactory: { hostProfileFor: (s: Pick<ServerConfig, 'hostProfile'>) => s.hostProfile, getAgentTransport: () => ({}) },
    harnessInstaller: harnessInstaller as unknown as HarnessInstaller,
    webhookToken: 'wh',
    publicUrl: HUB_URL,
    uiToken: 'ui',
    harnessHash: 'hash',
    serverIsolationMutex: new KeyedMutex(),
  } as unknown as ServersRouteOptions;
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return { app, harnessInstaller };
}

const SERVERS: Array<[string, ServerConfig, InstallMethod]> = [
  ['local', makeServer('local', null), 'installLocal'],
  ['ssh (Unix agent)', makeServer('agent', { platform: 'linux', arch: 'x64' }), 'install'],
  ['Windows agent', makeServer('agent', { platform: 'win32', arch: 'x64' }), 'installOnAgent'],
];

describe('POST /api/servers/:name/harness/install — azito_url is required (#498)', () => {
  describe.each(SERVERS)('%s server', (_label, server, method) => {
    it.each([
      ['missing', {}],
      ['empty', { azito_url: '' }],
      ['blank', { azito_url: '   ' }],
      ['not a string', { azito_url: 42 }],
    ])('%s azito_url is 400 azito_url_required and nothing is installed', async (_name, payload) => {
      const { app, harnessInstaller } = await buildApp(server);
      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/harness/install', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'azito_url is required', code: 'azito_url_required' });
      expect(harnessInstaller[method]).not.toHaveBeenCalled();
    });

    it('a request without a body is 400 azito_url_required', async () => {
      const { app, harnessInstaller } = await buildApp(server);
      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/harness/install' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'azito_url_required' });
      expect(harnessInstaller[method]).not.toHaveBeenCalled();
    });

    it('a malformed azito_url is 400 and nothing is installed', async () => {
      const { app, harnessInstaller } = await buildApp(server);
      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/harness/install', payload: { azito_url: 'not a url; rm -rf /' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid azito_url format' });
      expect(harnessInstaller[method]).not.toHaveBeenCalled();
    });

    it('a valid azito_url reaches the installer', async () => {
      const { app, harnessInstaller } = await buildApp(server);
      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/harness/install', payload: { azito_url: HUB_URL } });
      expect(res.statusCode).toBe(200);
      expect(harnessInstaller[method]).toHaveBeenCalledTimes(1);
      expect(harnessInstaller[method].mock.calls[0]).toContainEqual(expect.objectContaining({ azitoUrl: HUB_URL }));
    });
  });
});
