import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import gitRoutes from './routes';
import type { GitRouteOptions } from './routes';
import type { HostProfile } from '../../shared/os/hostProfile';
import type { ServerConfig } from '../servers/Server';
import type { CommandResult } from '../../shared/exec/commandSpec';
import { GitNotFoundError } from '../../shared/exec/commandSpec';
import { mapAppError } from '../../app/mapAppError';

type Run = (spec: unknown) => Promise<CommandResult>;

async function buildApp(hostProfile: HostProfile | null, run: Run) {
  const server = { name: 'srv', type: 'agent', hostProfile } as unknown as ServerConfig;
  const opts = {
    serverRepo: { findByName: (name: string) => (name === 'srv' ? server : null) },
    transportFactory: {
      hostProfileFor: (s: ServerConfig) => s.hostProfile,
      getTransport: () => ({ run, hostProfile, files: () => ({ platform: hostProfile?.platform ?? 'linux' }) }),
    },
    taskRepo: {},
    projectServerRepo: { find: () => ({ workingDirectory: 'C:\\work' }) },
    worktreeServiceFactory: { create: () => ({ list: async () => { await run({}); return []; } }) },
  } as unknown as GitRouteOptions;
  const app = Fastify();
  const defaultHandler = app.errorHandler;
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapAppError(err);
    if (mapped) return reply.status(mapped.status).send(mapped.body);
    return defaultHandler.call(app, err, request, reply);
  });
  await app.register(gitRoutes, opts);
  return app;
}

const win32: HostProfile = { platform: 'win32', arch: 'x64' };
const ok = async (): Promise<CommandResult> => ({ exitCode: 0, signal: null, stdout: '', stderr: '' });

describe('git API on a Windows server', () => {
  const urls = [
    '/api/servers/srv/git/diff?path=C:%5CUsers%5Ca',
    '/api/servers/srv/git/commits?path=C:%5CUsers%5Ca',
    '/api/servers/srv/git/worktrees?project_id=1',
  ];

  it.each(urls)('GET %s is not refused for the OS: it runs git', async (url) => {
    const run = vi.fn(ok);
    const app = await buildApp(win32, run);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(run).toHaveBeenCalled();
  });

  it.each(urls)('GET %s answers 501 git_not_found with the reason when the host has no Git for Windows', async (url) => {
    const reason = 'Git for Windows (git.exe) was not found on this host. Install it with "winget install --id Git.Git -e".';
    const app = await buildApp(win32, async () => { throw new GitNotFoundError(reason); });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ code: 'git_not_found', error: reason });
  });
});
