import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { formatMuxRef } from '@azito/shared';
import windowsRoutes from './routes';
import type { IWindowRepository } from './Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';

const MISAO_REF = formatMuxRef({ kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' });

async function buildApp(muxRuntime: ServerConfig['muxRuntime']) {
  const windowRepo = { findByServerAndTarget: vi.fn(() => undefined), create: vi.fn() };
  const app = Fastify();
  await app.register(windowsRoutes, {
    windowRepo: windowRepo as unknown as IWindowRepository,
    projectRepo: { findById: () => ({ id: 1 }) } as unknown as IProjectRepository,
    taskRepo: { findById: () => ({ id: 1 }) } as unknown as ITaskRepository,
    serverRepo: { findByName: () => ({ name: 's', muxRuntime }) } as unknown as IServerRepository,
  } as any);
  await app.ready();
  return { app, windowRepo };
}

describe('window registration with a misao ref', () => {
  it.each(['/api/projects/1/windows', '/api/tasks/1/windows'])('%s rejects a misao ref on a tmux server even with tmux_target', async (url) => {
    const { app, windowRepo } = await buildApp('system');
    const res = await app.inject({ method: 'POST', url, payload: { server_name: 's', tmux_target: 'a:b', ref: MISAO_REF } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid ref' });
    expect(windowRepo.findByServerAndTarget).not.toHaveBeenCalled();
  });
});
