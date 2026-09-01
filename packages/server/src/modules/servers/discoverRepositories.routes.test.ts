import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';

// GET /api/servers/:name/discover-repositories — the project-independent
// repository scan the create-project wizard calls before any project or
// project_servers row exists (Issue: project creation wizard). Shares
// RepoDiscoveryService.discover()/toDiscoveryResponse() with the
// project-scoped endpoint (projects/discoverRepositories.routes.test.ts
// covers the credential-stripping behavior of that shared shaping); this
// file focuses on what's specific to the project-independent route: path
// validation, path-status (`exists`/`isGitRepository`), and the 502 vs.
// "found nothing" distinction.

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'local',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
    isolationCleanupReport: null,
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(overrides: Partial<ServersRouteOptions> = {}): ServersRouteOptions {
  const serverRepo: IServerRepository = {
    findAll: vi.fn(() => []),
    findByName: vi.fn(() => makeServer()),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    updateIsolationIntent: vi.fn(),
    findMetaByNames: vi.fn(() => []),
    updateIsolationReport: vi.fn(),
    updateIsolationCleanupReport: vi.fn(),
    updateIsolationVerification: vi.fn(),
    updateIsolationFailure: vi.fn(),
    delete: vi.fn(),
  };
  return {
    serverRepo,
    tmux: { listSessionsForSecurityGate: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
    transportFactory: { invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    repoDiscovery: {
      checkPathStatus: vi.fn(async () => ({ exists: true, isGitRepository: false })),
      discover: vi.fn(async () => []),
    } as unknown as ServersRouteOptions['repoDiscovery'],
    ...overrides,
  };
}

async function buildApp(opts: ServersRouteOptions) {
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

describe('GET /api/servers/:name/discover-repositories', () => {
  it('rejects a missing path with 400', async () => {
    const app = await buildApp(makeOpts());
    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a relative path with 400', async () => {
    const app = await buildApp(makeOpts());
    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories?path=relative/dir' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the server does not exist', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const app = await buildApp(opts);
    const res = await app.inject({ method: 'GET', url: '/api/servers/ghost/discover-repositories?path=/work' });
    expect(res.statusCode).toBe(404);
  });

  it('returns exists:false without erroring when the path does not exist yet', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        checkPathStatus: vi.fn(async () => ({ exists: false, isGitRepository: false })),
        discover: vi.fn(async () => {
          throw new Error('discover() must not be called for a non-existent path');
        }),
      } as unknown as ServersRouteOptions['repoDiscovery'],
    });
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories?path=/does/not/exist' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: false, isGitRepository: false, repositories: [] });
  });

  it('returns 502 when the path status check fails (transport failure, not "found nothing")', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        checkPathStatus: vi.fn(async () => {
          throw new Error('boom');
        }),
        discover: vi.fn(async () => []),
      } as unknown as ServersRouteOptions['repoDiscovery'],
    });
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories?path=/work' });

    expect(res.statusCode).toBe(502);
  });

  it('returns 502 when the scan itself fails after the path is confirmed to exist', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        checkPathStatus: vi.fn(async () => ({ exists: true, isGitRepository: false })),
        discover: vi.fn(async () => {
          throw new Error('scan failed');
        }),
      } as unknown as ServersRouteOptions['repoDiscovery'],
    });
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories?path=/work' });

    expect(res.statusCode).toBe(502);
  });

  it('reports isGitRepository:true and the repositories found under an existing git root', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        checkPathStatus: vi.fn(async () => ({ exists: true, isGitRepository: true })),
        discover: vi.fn(async () => [
          {
            relativePath: '.',
            absolutePath: '/work/repo',
            remotes: [
              {
                name: 'origin',
                url: 'git@github.com:acme/widgets.git',
                parsed: { provider: 'github' as const, owner: 'acme', repoName: 'widgets', host: 'github.com' },
              },
            ],
          },
        ]),
      } as unknown as ServersRouteOptions['repoDiscovery'],
    });
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories?path=/work/repo' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(body.isGitRepository).toBe(true);
    expect(body.repositories).toHaveLength(1);
    // alreadyRegistered is always false here: no project exists yet at this
    // point in the wizard for anything to already be registered against.
    expect(body.repositories[0].remotes[0].alreadyRegistered).toBe(false);
  });

  it('returns 501 when repoDiscovery is not wired', async () => {
    const opts = makeOpts({ repoDiscovery: undefined });
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/local/discover-repositories?path=/work' });

    expect(res.statusCode).toBe(501);
  });
});
