import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { formatMuxRef } from '@azito/shared';
import windowsRoutes from './routes';
import type { IWindowRepository } from './Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';

const MISAO_REF = formatMuxRef({ kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' });
const URLS = ['/api/projects/1/windows', '/api/tasks/1/windows'];

async function buildApp(defaultMux: ServerConfig['defaultMux'], registerMisao = false, type: ServerConfig['type'] = 'local') {
  const windowRepo = { findByServerAndTarget: vi.fn(() => undefined), findByServerAndRef: vi.fn(() => undefined), add: vi.fn(() => 7), create: vi.fn(), update: vi.fn(), adoptForTask: vi.fn() };
  const muxDriverRegistry = new MuxDriverRegistry();
  muxDriverRegistry.register('tmux', { kind: 'tmux' } as unknown as IMuxClient);
  if (registerMisao) muxDriverRegistry.register('misao', { kind: 'misao', supportsPaneLabels: false } as unknown as IMuxClient);
  const app = Fastify();
  await app.register(windowsRoutes, {
    windowRepo: windowRepo as unknown as IWindowRepository,
    projectRepo: { findById: () => ({ id: 1 }) } as unknown as IProjectRepository,
    taskRepo: { findById: () => ({ id: 1 }) } as unknown as ITaskRepository,
    serverRepo: { findByName: () => ({ name: 's', type, defaultMux }) } as unknown as IServerRepository,
    muxDriverRegistry,
    sessionCaptureService: { scheduleInitialScan: vi.fn() },
  } as any);
  await app.ready();
  return { app, windowRepo };
}

describe('window registration with a misao ref', () => {
  it.each(URLS)('%s rejects a misao ref on a tmux-only (agent) server even with tmux_target', async (url) => {
    const { app, windowRepo } = await buildApp('tmux', true, 'agent');
    const res = await app.inject({ method: 'POST', url, payload: { server_name: 's', tmux_target: 'a:b', ref: MISAO_REF } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid ref' });
    expect(windowRepo.findByServerAndTarget).not.toHaveBeenCalled();
  });
});

describe('window registration with only a misao ref', () => {
  it.each(URLS)('%s derives tmux_target as <workspace>:<window id> from the ref', async (url) => {
    const { app, windowRepo } = await buildApp('misao', true);
    const res = await app.inject({ method: 'POST', url, payload: { server_name: 's', ref: MISAO_REF } });
    expect(res.statusCode).toBe(200);
    expect(windowRepo.findByServerAndTarget).toHaveBeenCalledWith('s', 'ws:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8');
  });

  it.each(URLS)('%s stores <workspace>:<window id> even when an ordinal or display-name target is sent (M-022)', async (url) => {
    const { app, windowRepo } = await buildApp('tmux', true);
    const res = await app.inject({ method: 'POST', url, payload: { server_name: 's', tmux_target: 'ws:0', ref: MISAO_REF } });
    expect(res.statusCode).toBe(200);
    expect(windowRepo.findByServerAndTarget).toHaveBeenCalledWith('s', 'ws:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8');
    expect(windowRepo.findByServerAndTarget).not.toHaveBeenCalledWith('s', 'ws:0');
  });
});

describe('window registration on a server whose mux driver is unavailable', () => {
  it.each(URLS)(
    '%s rejects without writing a window row',
    async (url) => {
      const reason = 'driver_not_registered';
      const { app, windowRepo } = await buildApp('misao');
      const res = await app.inject({ method: 'POST', url, payload: { server_name: 's', tmux_target: 'a:b', ref: MISAO_REF } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'mux_driver_unavailable', kind: 'misao', reason });
      expect(windowRepo.findByServerAndTarget).not.toHaveBeenCalled();
      expect(windowRepo.create).not.toHaveBeenCalled();
      expect(windowRepo.update).not.toHaveBeenCalled();
      expect(windowRepo.adoptForTask).not.toHaveBeenCalled();
    },
  );
});
