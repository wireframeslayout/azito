import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import gitRoutes from './routes';
import type { GitRouteOptions } from './routes';
import type { HostProfile } from '../../shared/os/hostProfile';
import type { ServerConfig } from '../servers/Server';
import { mapAppError } from '../../app/mapAppError';

async function buildApp(hostProfile: HostProfile | null) {
  const server = { name: 'srv', type: 'agent', hostProfile } as unknown as ServerConfig;
  const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const opts = {
    serverRepo: { findByName: (name: string) => (name === 'srv' ? server : null) },
    transportFactory: { hostProfileFor: (s: ServerConfig) => s.hostProfile, getTransport: () => ({ run, hostProfile }) },
    taskRepo: {},
    projectServerRepo: { find: () => ({ workingDirectory: 'C:\\work' }) },
    worktreeServiceFactory: { create: () => ({ list: async () => [] }) },
  } as unknown as GitRouteOptions;
  const app = Fastify();
  const defaultHandler = app.errorHandler;
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapAppError(err);
    if (mapped) return reply.status(mapped.status).send(mapped.body);
    return defaultHandler.call(app, err, request, reply);
  });
  await app.register(gitRoutes, opts);
  return { app, run };
}

describe('git API on a Windows server', () => {
  const win32: HostProfile = { platform: 'win32', arch: 'x64' };

  it.each([
    '/api/servers/srv/git/diff?path=C:%5CUsers%5Ca',
    '/api/servers/srv/git/commits?path=C:%5CUsers%5Ca',
    '/api/servers/srv/git/worktrees?project_id=1',
  ])('GET %s is 501 unsupported_os (not "Invalid path")', async (url) => {
    const { app, run } = await buildApp(win32);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'unsupported_os', error: expect.stringContaining('win32') });
    expect(run).not.toHaveBeenCalled();
  });

  it('a Linux server is not refused', async () => {
    const { app } = await buildApp({ platform: 'linux', arch: 'x64' });
    const res = await app.inject({ method: 'GET', url: '/api/servers/srv/git/worktrees?project_id=1' });
    expect(res.statusCode).toBe(200);
  });
});
