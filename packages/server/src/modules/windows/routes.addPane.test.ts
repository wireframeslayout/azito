import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import windowsRoutes from './routes';
import { KeyedMutex } from '../../shared/keyedMutex';
import type { IWindowRepository, Window } from './Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { WindowRespawnService } from './WindowRespawnService';
import type { WindowSleepService } from './WindowSleepService';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import type { SessionCaptureService } from './SessionCaptureService';
import type { WindowActivityStatusService } from './WindowActivityStatusService';

const MASKED = { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '', AZITO_WEBHOOK_TOKEN: '' };
const ref = { kind: 'misao' as const, workspace: 'ws-a', window: 'w_0123456789ABCDEFGHJKMNPQRS' };

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 5, ownerType: 'project', projectId: 1, taskId: null, serverName: 'misao1', tmuxTarget: 'ws-a:main', muxRef: ref,
    label: 'm', isPrimary: false, windowType: 'agent', workerType: 'claude', workerModel: null, agentSessionId: null,
    launchCommand: null, workingDirectory: null, paneLayout: null, sleeping: false, createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('POST /api/windows/:id/panes', () => {
  let app: FastifyInstance;
  let lockHeld = false;
  const heldAt: boolean[] = [];
  const splitPaneByHandle = vi.fn(async () => { heldAt.push(lockHeld); return { handle: 'p_2', result: { stdout: '', stderr: '', code: 0 } }; });
  const driver = { splitPaneByHandle, resolvePane: vi.fn(async () => 'p_1') };
  const normal = { name: 'misao1', type: 'local', muxRuntime: 'misao', isolationIntent: false } as ServerConfig;
  const isolated = { ...normal, isolationIntent: true } as ServerConfig;

  async function build(server: ServerConfig, window: Window, buildSecondaryWindowEnv?: (taskId: number, s: ServerConfig) => Record<string, string>): Promise<void> {
    const mutex = new KeyedMutex();
    const withLock = mutex.withLock.bind(mutex);
    mutex.withLock = (async (key: string, fn: () => Promise<unknown>) => withLock(key, async () => { lockHeld = true; try { return await fn(); } finally { lockHeld = false; } })) as typeof mutex.withLock;
    app = Fastify();
    await app.register(windowsRoutes, {
      windowRepo: { findById: (id: number) => (id === window.id ? window : undefined) } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => driver } as never,
      serverRepo: { findByName: (name: string) => (name === server.name ? server : null) } as unknown as IServerRepository,
      respawnService: {} as WindowRespawnService,
      sleepService: {} as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: {} as SessionCaptureService,
      supervisorRegistry: {} as SupervisorRegistry,
      windowActivityStatusService: {} as WindowActivityStatusService,
      uiToken: 'test-token',
      serverIsolationMutex: mutex,
      buildSecondaryWindowEnv,
    });
    await app.ready();
  }

  afterEach(async () => {
    splitPaneByHandle.mockClear();
    heldAt.length = 0;
    await app.close();
  });

  it('gives a manual pane the UI token env, splitting inside the lock', async () => {
    await build(normal, makeWindow());
    const res = await app.inject({ method: 'POST', url: '/api/windows/5/panes', payload: { direction: 'h' } });
    expect(res.statusCode).toBe(200);
    expect(splitPaneByHandle).toHaveBeenCalledWith(normal, 'p_1', 'h', { AZITO_UI_TOKEN: 'test-token' });
    expect(heldAt).toEqual([true]);
  });

  it('gives an isolated server the credential mask, never the UI token', async () => {
    await build(isolated, makeWindow());
    await app.inject({ method: 'POST', url: '/api/windows/5/panes', payload: {} });
    expect(splitPaneByHandle).toHaveBeenCalledWith(isolated, 'p_1', 'v', MASKED);
  });

  it('gives a secondary task window its own masked env', async () => {
    const taskEnv = { AZITO_TASK_ID: '42', ...MASKED };
    const buildSecondaryWindowEnv = vi.fn(() => taskEnv);
    await build(normal, makeWindow({ ownerType: 'task', taskId: 42, isPrimary: false }), buildSecondaryWindowEnv);
    const res = await app.inject({ method: 'POST', url: '/api/windows/5/panes', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(buildSecondaryWindowEnv).toHaveBeenCalledWith(42, normal);
    expect(splitPaneByHandle).toHaveBeenCalledWith(normal, 'p_1', 'v', taskEnv);
  });

  it("refuses a task's primary window with 409 and splits nothing", async () => {
    await build(normal, makeWindow({ ownerType: 'task', taskId: 42, isPrimary: true }));
    const res = await app.inject({ method: 'POST', url: '/api/windows/5/panes', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('primary_task_window_pane_add_unsupported');
    expect(splitPaneByHandle).not.toHaveBeenCalled();
  });
});
