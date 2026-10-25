import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import type { HostProfile } from '../../shared/os/hostProfile';
import { mapAppError } from '../../app/mapAppError';

// Turning the code distribution on for a server is decided by the OS of the TARGET server (hostFeatureSupport 'codeDistribution', #464):
// a Windows agent is refused with 501 unsupported_os, a Linux / macOS agent is accepted whatever OS the hub runs on.

const PROJECT = { id: 10, name: 'P', slug: 'p', repositories: [] };
const WIN: HostProfile = { platform: 'win32', arch: 'x64' };
const LINUX: HostProfile = { platform: 'linux', arch: 'x64' };

async function setup(profile: HostProfile | null, existing: { distributeCode: boolean } | null = null) {
  const upsert = vi.fn();
  const server = { name: 'srv', type: 'agent', hostProfile: profile };
  const opts = {
    projectRepo: { findById: vi.fn(() => PROJECT) },
    projectServerRepo: { find: vi.fn(() => existing), upsert },
    serverRepo: { findByName: vi.fn(() => server) },
    transportFactory: { hostProfileFor: vi.fn((s: { hostProfile: HostProfile | null }) => s.hostProfile) },
  } as unknown as ProjectsRouteOptions;
  const app = Fastify();
  app.setErrorHandler((err, _request, reply) => { const mapped = mapAppError(err); if (!mapped) throw err; return reply.status(mapped.status).send(mapped.body); });
  await app.register(projectsRoutes, opts);
  await app.ready();
  return { app, upsert };
}

const put = (app: Awaited<ReturnType<typeof setup>>['app'], payload: object) => app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload });

describe('PUT /api/projects/:id/servers/:serverName — distribute_code on a Windows agent (#464)', () => {
  it('refuses to turn it on: 501 unsupported_os naming #464, nothing saved', async () => {
    const { app, upsert } = await setup(WIN);
    const res = await put(app, { distribute_code: true });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'unsupported_os', error: expect.stringContaining('#464') });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('accepts it for a Linux / macOS agent and one whose OS is not recorded', async () => {
    for (const profile of [LINUX, { platform: 'darwin', arch: 'arm64' } as HostProfile, null]) {
      const { app, upsert } = await setup(profile);
      expect((await put(app, { distribute_code: true })).statusCode).toBe(200);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ distributeCode: true }));
    }
  });

  it('turning it off, and saving other fields on a row that already has it, still work on a Windows agent', async () => {
    const off = await setup(WIN, { distributeCode: true });
    expect((await put(off.app, { distribute_code: false })).statusCode).toBe(200);
    expect(off.upsert).toHaveBeenCalledWith(expect.objectContaining({ distributeCode: false }));
    const other = await setup(WIN, { distributeCode: true });
    expect((await put(other.app, { branch: 'main' })).statusCode).toBe(200);
  });
});
