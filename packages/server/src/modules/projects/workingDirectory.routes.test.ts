import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import type { HostProfile } from '../../shared/os/hostProfile';

// PUT /api/projects/:id/servers/:serverName stores a working directory that every later git / file / worktree
// operation resolves against. New input is checked with the rules of the server's OS; an unset value (null / '')
// and a body without the key are left as they were.

const PROJECT = { id: 10, name: 'P', slug: 'p', repositories: [] };

async function setup(profile: HostProfile | null, serverExists = true) {
  const upsert = vi.fn();
  const server = { name: 'srv', type: 'agent', hostProfile: profile };
  const opts = {
    projectRepo: { findById: vi.fn(() => PROJECT) },
    projectServerRepo: { find: vi.fn(() => null), upsert },
    serverRepo: { findByName: vi.fn(() => (serverExists ? server : null)) },
    transportFactory: { hostProfileFor: vi.fn((s: { hostProfile: HostProfile | null }) => s.hostProfile) },
  } as unknown as ProjectsRouteOptions;
  const app = Fastify();
  await app.register(projectsRoutes, opts);
  await app.ready();
  return { app, upsert, opts };
}

const WIN: HostProfile = { platform: 'win32', arch: 'x64' };
const LINUX: HostProfile = { platform: 'linux', arch: 'x64' };

describe('PUT /api/projects/:id/servers/:serverName — working_directory validation', () => {
  it.each([
    [LINUX, '/home/me/my repo'],
    [LINUX, '/home/me/日本語'],
    [LINUX, '~/work'],
    [WIN, 'C:\\Users\\me\\My Repo'],
    [WIN, 'D:/work/日本語'],
    [WIN, '\\\\srv\\share\\repo'],
    [WIN, '~\\work'],
  ])('accepts %j %j', async (profile, dir) => {
    const { app, upsert } = await setup(profile);
    const res = await app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload: { working_directory: dir } });
    expect(res.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: dir }));
  });

  it.each([
    [LINUX, 'relative/dir', /absolute/],
    [LINUX, 'C:\\Users\\me', /absolute/],
    [LINUX, '~\\work', /absolute/],
    [WIN, 'relative\\dir', /absolute/],
    [WIN, 'C:foo', /drive-relative/],
    [WIN, '\\\\.\\C:\\x', /device/],
    [WIN, 'C:\\dir:stream', /alternate data stream/],
    [LINUX, 'a\0b', /NUL/],
  ])('rejects %j %j with 400 and the reason', async (profile, dir, reason) => {
    const { app, upsert } = await setup(profile);
    const res = await app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload: { working_directory: dir } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Invalid working_directory: /);
    expect(res.json().error).toMatch(reason);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-string value', async () => {
    const { app, upsert } = await setup(LINUX);
    const res = await app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload: { working_directory: 5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/must be a string/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps null, empty and an absent key as they were', async () => {
    const { app, upsert } = await setup(LINUX);
    for (const payload of [{ working_directory: null }, { working_directory: '' }, {}]) {
      const res = await app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload });
      expect(res.statusCode).toBe(200);
    }
    expect(upsert.mock.calls.map((c) => c[0].workingDirectory)).toEqual([null, '', null]);
  });

  it('with an agent whose OS is not known yet, accepts a path valid on any OS', async () => {
    const { app } = await setup(null);
    const ok = await app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload: { working_directory: 'C:\\Users\\me' } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'PUT', url: '/api/projects/10/servers/srv', payload: { working_directory: 'relative' } });
    expect(bad.statusCode).toBe(400);
  });
});
