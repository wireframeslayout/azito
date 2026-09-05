import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import windowsRoutes from './routes';
import type { Window, IWindowRepository } from './Window';
import type { ServerConfig, IServerRepository } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { WindowRespawnService } from './WindowRespawnService';
import type { WindowSleepService } from './WindowSleepService';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import type { SupervisorRegistry, SupervisorEntry } from '../supervisors/SupervisorRegistry';
import type { SessionCaptureService } from './SessionCaptureService';
import type { WindowActivityStatusService } from './WindowActivityStatusService';

function makeSupervisorRegistry(
  entries: SupervisorEntry[] = [],
  exitedTargets: string[] = [],
): SupervisorRegistry {
  return {
    snapshot: () => entries,
    hasRecentChildExit: (_serverName: string, target: string) => exitedTargets.includes(target),
    clearExitMarker: vi.fn(),
    issueLaunch: vi.fn(() => undefined),
  } as unknown as SupervisorRegistry;
}

function makeWindowActivityStatusService(): WindowActivityStatusService {
  return { list: async () => [] } as unknown as WindowActivityStatusService;
}

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1,
    ownerType: 'project',
    projectId: 1,
    taskId: null,
    serverName: 'local-server',
    tmuxTarget: 'proj:win1',
    label: 'manual-agent',
    isPrimary: false,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    sleeping: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'local-server',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null,
  muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('POST /api/windows/:id/launch-agent', () => {
  let app: FastifyInstance;
  let window: Window;
  let server: ServerConfig;
  let sendKeys: ReturnType<typeof vi.fn>;
  let updateByWindowFn: ReturnType<typeof vi.fn<IWindowRepository['updateAgentSessionIdByWindow']>>;

  beforeEach(async () => {
    window = makeWindow();
    server = makeServer();
    sendKeys = vi.fn().mockResolvedValue(undefined);
    updateByWindowFn = vi.fn<IWindowRepository['updateAgentSessionIdByWindow']>();

    const windowRepo: Partial<IWindowRepository> = {
      findById: (id: number) => (id === window.id ? window : undefined),
      updateAgentSessionIdByWindow: updateByWindowFn,
    };
    const serverRepo: Partial<IServerRepository> = {
      findByName: (name: string) => (name === server.name ? server : null),
    };
    const tmux: Partial<TmuxClient> = {
      sendKeys: sendKeys as unknown as TmuxClient['sendKeys'],
      resolvePaneId: vi.fn().mockResolvedValue('%0') as unknown as TmuxClient['resolvePaneId'],
    };

    app = Fastify();
    await app.register(windowsRoutes, {
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: tmux as TmuxClient,
      serverRepo: serverRepo as IServerRepository,
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {
        create: () => ({
          supportsSession: true,
          needsPostLaunchScan: false,
          buildNewSessionFlags: (id: string) => `--session-id ${id}`,
          buildResumeFlags: (id: string) => `--resume ${id}`,
          buildRespawnCommand: () => null,
          scanSessionId: vi.fn().mockResolvedValue(null),
        }),
      } as unknown as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowActivityStatusService: makeWindowActivityStatusService(),
    });
    await app.ready();
  });

  it('wraps the command with tui-supervisor for an agent window on a local server', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --model opus' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, supervised: true });
    expect(sendKeys).toHaveBeenCalledTimes(1);
    const [, paneTarget, keys] = sendKeys.mock.calls[0];
    expect(keys[0]).toContain('tui-supervisor');
    expect(keys[0]).toMatch(/'claude --model opus --session-id [0-9a-f-]{36}'/);
    expect(keys[1]).toBe('Enter');
    // sendKeys targets the resolved pane ID...
    expect(paneTarget).toBe('%0');
    // ...but the supervisor's --target must equal the window's stored tmuxTarget
    // (un-pane-suffixed) so AgentActivityMonitor Tier 0 refines the same key
    // instead of creating a duplicate `proj:win1.1` entry.
    expect(keys[0]).toContain(`--target 'proj:win1'`);
    expect(keys[0]).not.toContain(`proj:win1.1`);
  });



  it('sends the plain command for terminal windows', async () => {
    window = makeWindow({ windowType: 'terminal' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --model opus' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, supervised: false });
    const [, , keys] = sendKeys.mock.calls[0];
    expect(keys[0]).toMatch(/^claude --model opus --session-id [0-9a-f-]{36}$/);
  });

  it('returns 400 when command is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('returns 404 when window does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/windows/999/launch-agent',
      payload: { command: 'claude' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('pre-assigns --session-id for claude workers and saves it before sendKeys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --model opus' },
    });
    expect(res.statusCode).toBe(200);
    const [, , keys] = sendKeys.mock.calls[0];
    const sentCommand = keys[0];
    expect(sentCommand).toMatch(/--session-id [0-9a-f-]{36}/);
    expect(updateByWindowFn).toHaveBeenCalledTimes(1);
    expect(updateByWindowFn.mock.calls[0][0]).toBe(window.serverName);
    expect(updateByWindowFn.mock.calls[0][1]).toBe(window.tmuxTarget);
    const savedId = updateByWindowFn.mock.calls[0][2] as string;
    expect(savedId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not add --session-id when the command already contains one, but saves the existing id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --session-id existing-uuid' },
    });
    expect(res.statusCode).toBe(200);
    const [, , keys] = sendKeys.mock.calls[0];
    const sentCommand = keys[0];
    expect(sentCommand.match(/--session-id/g)).toHaveLength(1);
    expect(updateByWindowFn).toHaveBeenCalledTimes(1);
    expect(updateByWindowFn.mock.calls[0][2]).toBe('existing-uuid');
  });

  it('does not add --session-id when the command contains --resume, but saves the resume id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --resume abc-123' },
    });
    expect(res.statusCode).toBe(200);
    const [, , keys] = sendKeys.mock.calls[0];
    const sentCommand = keys[0];
    expect(sentCommand).not.toContain('--session-id');
    expect(updateByWindowFn).toHaveBeenCalledTimes(1);
    expect(updateByWindowFn.mock.calls[0][2]).toBe('abc-123');
  });

  it('does not pre-assign session-id for codex workers (needsPostLaunchScan=true)', async () => {
    const codexUpdateByWindowFn = vi.fn();
    window = makeWindow({ workerType: 'codex' });
    const codexApp = Fastify();
    await codexApp.register(windowsRoutes, {
      windowRepo: {
        findById: (id: number) => (id === window.id ? window : undefined),
        updateAgentSessionIdByWindow: codexUpdateByWindowFn,
      } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {
        sendKeys: sendKeys as unknown as TmuxClient['sendKeys'],
        resolvePaneId: vi.fn().mockResolvedValue('%0') as unknown as TmuxClient['resolvePaneId'],
      } as TmuxClient,
      serverRepo: {
        findByName: (name: string) => (name === server.name ? server : null),
      } as unknown as IServerRepository,
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {
        create: () => ({
          supportsSession: true,
          needsPostLaunchScan: true,
          buildNewSessionFlags: () => '',
          buildResumeFlags: (id: string) => `--resume ${id}`,
          buildRespawnCommand: () => null,
          scanSessionId: vi.fn().mockResolvedValue(null),
        }),
      } as unknown as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowActivityStatusService: makeWindowActivityStatusService(),
    });
    await codexApp.ready();

    const res = await codexApp.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'codex' },
    });
    expect(res.statusCode).toBe(200);
    const [, , keys] = sendKeys.mock.calls[0];
    expect(keys[0]).not.toContain('--session-id');
    expect(codexUpdateByWindowFn).not.toHaveBeenCalled();
    await codexApp.close();
  });
});

describe('GET /api/windows/pane-loading-state', () => {
  let app: FastifyInstance;

  async function setup(
    win: Window | undefined,
    supervisorEntries: SupervisorEntry[] = [],
    exitedTargets: string[] = [],
  ): Promise<FastifyInstance> {
    const windowRepo: Partial<IWindowRepository> = {
      findByServerAndTarget: (serverName: string, tmuxTarget: string) =>
        win && win.serverName === serverName && win.tmuxTarget.replace(/\.\d+$/, '') === tmuxTarget.replace(/\.\d+$/, '')
          ? win
          : undefined,
    };
    const instance = Fastify();
    await instance.register(windowsRoutes, {
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      serverRepo: { findByName: () => makeServer() } as unknown as IServerRepository,
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(supervisorEntries, exitedTargets),
      windowActivityStatusService: makeWindowActivityStatusService(),
    });
    await instance.ready();
    return instance;
  }

  it('returns supervised:false/ready:null/childCommand:null when no window row matches', async () => {
    app = await setup(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/api/windows/pane-loading-state?server_name=local-server&tmux_target=proj:win1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ supervised: false, ready: null, childCommand: null });
  });

  it('reports supervised:true/ready:null with the stored launch command as a fallback when the supervisor has not registered yet', async () => {
    const win = makeWindow({ launchCommand: 'claude --dangerously-skip-permissions' });
    app = await setup(win, []);
    const res = await app.inject({
      method: 'GET',
      // Request with a pane-suffixed target (as a pane click / task window would produce) to
      // confirm the window-granularity match strips it before comparing.
      url: '/api/windows/pane-loading-state?server_name=local-server&tmux_target=proj:win1.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      supervised: true,
      ready: null,
      childCommand: 'claude --dangerously-skip-permissions',
    });
  });

  it('reports supervised:false when the window\'s supervisor already exited and none has re-registered', async () => {
    const win = makeWindow({ launchCommand: 'claude --dangerously-skip-permissions' });
    // No live entry (supervisor process gone) and a recorded child_exit for this window's own
    // tmuxTarget — nothing left to wait for, so the overlay should fail open rather than wait
    // out the full 10s timeout.
    app = await setup(win, [], [win.tmuxTarget]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/windows/pane-loading-state?server_name=local-server&tmux_target=proj:win1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      supervised: false,
      ready: null,
      childCommand: 'claude --dangerously-skip-permissions',
    });
  });

  it('returns the live supervisor entry\'s ready/childCommand once registered', async () => {
    const win = makeWindow({ launchCommand: 'claude --dangerously-skip-permissions' });
    const entry: SupervisorEntry = {
      serverName: 'local-server',
      target: 'proj:win1',
      taskId: null,
      unitId: null,
      pid: 1234,
      childCommand: 'claude --dangerously-skip-permissions',
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      ready: false,
      bound: true,
      lastActivityFrameAt: null,
      lastReportedState: null,
      lastReportedStatus: null,
      muxPaneRef: null,
    };
    app = await setup(win, [entry]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/windows/pane-loading-state?server_name=local-server&tmux_target=proj:win1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      supervised: true,
      ready: false,
      childCommand: 'claude --dangerously-skip-permissions',
    });
  });

  it('returns 400 when server_name or tmux_target is missing', async () => {
    app = await setup(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/windows/pane-loading-state?server_name=local-server' });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/windows/:id/respawn — execution gate (Issue #328 second-round fix)', () => {
  // Previously this route called respawnService.respawn() unwrapped, so a
  // thrown ExecutionGatePendingApprovalError/ExecutionGateDeniedError fell
  // through to Fastify's default error handler as a generic 500 instead of
  // the 409/403 that /api/tasks/:id/recover-session and
  // /api/units/:id/execute|follow-up already return for the same errors.
  let app: FastifyInstance;
  let window: Window;
  let server: ServerConfig;

  async function setup(respawn: WindowRespawnService['respawn']): Promise<FastifyInstance> {
    const windowRepo: Partial<IWindowRepository> = {
      findById: (id: number) => (id === window.id ? window : undefined),
    };
    const serverRepo: Partial<IServerRepository> = {
      findByName: (name: string) => (name === server.name ? server : null),
    };
    const instance = Fastify();
    await instance.register(windowsRoutes, {
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      serverRepo: serverRepo as IServerRepository,
      respawnService: { respawn } as unknown as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowActivityStatusService: makeWindowActivityStatusService(),
    });
    await instance.ready();
    return instance;
  }

  beforeEach(() => {
    window = makeWindow();
    server = makeServer();
  });

  it('translates ExecutionGatePendingApprovalError into 409 execution_pending_approval (not a generic 500)', async () => {
    const { ExecutionGatePendingApprovalError } = await import('../tasks/execution/ExecutionGate.js');
    app = await setup(vi.fn(async () => { throw new ExecutionGatePendingApprovalError(window.taskId ?? 1); }));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'execution_pending_approval' });
  });

  it('translates ExecutionGateDeniedError into 403 execution_denied (not a generic 500)', async () => {
    const { ExecutionGateDeniedError } = await import('../tasks/execution/ExecutionGate.js');
    app = await setup(vi.fn(async () => { throw new ExecutionGateDeniedError(window.taskId ?? 1); }));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'execution_denied' });
  });

  it('re-throws (and does not swallow) errors unrelated to the execution gate', async () => {
    app = await setup(vi.fn(async () => { throw new Error('tmux exploded'); }));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(500);
  });

  it('still succeeds and returns tmuxTarget when the gate allows execution', async () => {
    app = await setup(vi.fn(async () => ({ tmuxTarget: 'proj:win1' })));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tmuxTarget: 'proj:win1' });
  });
});

describe('GET /api/windows/activity-status (Issue #338 フォロー: process-based liveness supplement)', () => {
  it('proxies the WindowActivityStatusService snapshot as-is', async () => {
    const entries = [
      { windowId: 20, serverName: 'local', target: 'test:win--39vh', status: 'working' as const, projectId: 6 },
    ];
    const app = Fastify();
    await app.register(windowsRoutes, {
      windowRepo: {} as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      serverRepo: {} as IServerRepository,
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowActivityStatusService: { list: async () => entries } as unknown as WindowActivityStatusService,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/windows/activity-status' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(entries);
  });
});

describe('POST /api/windows/:id/sleep', () => {
  function makeApp(opts: { window?: Window | undefined; canSleep?: boolean; sleepFn?: ReturnType<typeof vi.fn> }) {
    const win = opts.window;
    const canSleepFn = vi.fn(() => opts.canSleep ?? true);
    const sleepFn = opts.sleepFn ?? vi.fn(async () => {});
    const app = Fastify();
    app.register(windowsRoutes, {
      windowRepo: {
        findById: (id: number) => (win && id === win.id ? win : undefined),
      } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      serverRepo: {
        findByName: () => ({ name: 'local-server', type: 'local' }),
      } as unknown as IServerRepository,
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: canSleepFn, sleep: sleepFn } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowActivityStatusService: makeWindowActivityStatusService(),
    });
    return { app, canSleepFn, sleepFn };
  }

  it('returns 200 and calls sleep when the window can be slept', async () => {
    const win = makeWindow({ id: 5, agentSessionId: 'sess-1' });
    const { app, sleepFn } = makeApp({ window: win, canSleep: true });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/windows/5/sleep' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(sleepFn).toHaveBeenCalledWith(5);
  });

  it('returns 400 when canSleep is false', async () => {
    const win = makeWindow({ id: 5, windowType: 'terminal', workerType: null });
    const { app, sleepFn } = makeApp({ window: win, canSleep: false });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/windows/5/sleep' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('cannot be put to sleep') });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('returns 404 when the window does not exist', async () => {
    const { app, sleepFn } = makeApp({ window: undefined });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/windows/999/sleep' });
    expect(res.statusCode).toBe(404);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
