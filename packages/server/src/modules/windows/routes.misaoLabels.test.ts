import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { formatMuxRef, type MuxRef } from '@azito/shared';
import windowsRoutes from './routes';
import type { IWindowRepository } from './Window';
import type { IServerRepository } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';

const REF: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' };

async function buildApp(labelWindowPanes = vi.fn(async () => undefined)) {
  const windowRepo = {
    findByServerAndTarget: vi.fn(() => undefined),
    findByServerAndRef: vi.fn(() => undefined),
    add: vi.fn(() => 42),
    remove: vi.fn(),
    update: vi.fn(),
  };
  const driver = {
    kind: 'misao',
    supportsPaneLabels: true,
    labelWindowPanes,
    listWorkspaces: vi.fn(async () => [{ name: 'ws', windowCount: 1, attached: false, created: 0, windows: [{ index: 0, name: 'main', active: false, panes: [], activity: 0, ref: REF }] }]),
  } as unknown as IMuxClient;
  const muxDriverRegistry = new MuxDriverRegistry();
  muxDriverRegistry.register('misao', driver);
  const app = Fastify();
  await app.register(windowsRoutes, {
    windowRepo: windowRepo as unknown as IWindowRepository,
    projectRepo: { findById: () => ({ id: 1 }) } as unknown as IProjectRepository,
    taskRepo: { findById: () => ({ id: 7 }) } as unknown as ITaskRepository,
    serverRepo: { findByName: () => ({ name: 's', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system' }) } as unknown as IServerRepository,
    sessionCaptureService: { scheduleInitialScan: vi.fn() },
    muxDriverRegistry,
  } as any);
  await app.ready();
  return { app, windowRepo, labelWindowPanes };
}

describe('window registration labels misao panes', () => {
  it('POST /api/projects/:id/windows labels the new window with its row id', async () => {
    const { app, labelWindowPanes } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/1/windows', payload: { server_name: 's', tmux_target: 'ws:main', ref: formatMuxRef(REF) } });
    expect(res.statusCode).toBe(200);
    expect(labelWindowPanes).toHaveBeenCalledWith(expect.objectContaining({ name: 's' }), REF, { windowId: 42 });
  });

  it('POST /api/tasks/:id/windows labels the new window with its row id and task id', async () => {
    const { app, labelWindowPanes } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/tasks/7/windows', payload: { server_name: 's', tmux_target: 'ws:main', ref: formatMuxRef(REF) } });
    expect(res.statusCode).toBe(200);
    expect(labelWindowPanes).toHaveBeenCalledWith(expect.objectContaining({ name: 's' }), REF, { windowId: 42, taskId: 7 });
  });

  it('POST /api/projects/:id/windows/session stores the misao ref and labels each window', async () => {
    const { app, windowRepo, labelWindowPanes } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/1/windows/session', payload: { server_name: 's', session: 'ws' } });
    expect(res.statusCode).toBe(200);
    expect(windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({ muxRef: REF }));
    expect(labelWindowPanes).toHaveBeenCalledWith(expect.objectContaining({ name: 's' }), REF, { windowId: 42 });
  });

  it('removes the row when labelling fails so a retry registers it again', async () => {
    const { app, windowRepo } = await buildApp(vi.fn(async () => { throw new Error('set_label failed'); }));
    const res = await app.inject({ method: 'POST', url: '/api/projects/1/windows', payload: { server_name: 's', tmux_target: 'ws:main', ref: formatMuxRef(REF) } });
    expect(res.statusCode).toBe(500);
    expect(windowRepo.remove).toHaveBeenCalledWith(42);
  });
});
