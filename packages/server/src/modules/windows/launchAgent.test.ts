import { KeyedMutex } from '../../shared/keyedMutex';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mapAppError } from '../../app/mapAppError';
import { PaneReplaceRefusedError } from '../tmux/MuxCapabilityError';
import windowsRoutes, { type WindowsRouteOptions } from './routes';
import type { Window, IWindowRepository } from './Window';
import type { ServerConfig, IServerRepository } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { WindowRespawnService } from './WindowRespawnService';
import type { WindowSleepService } from './WindowSleepService';
import type { ISessionStrategyFactory, ISessionStrategy } from '../agents/SessionStrategy';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import type { SessionCaptureService } from './SessionCaptureService';
import type { WindowActivityStatusService } from './WindowActivityStatusService';

// ─── Helpers ───

function makeSupervisorRegistry(): SupervisorRegistry {
  return {
    snapshot: () => [],
    hasRecentChildExit: () => false,
    clearExitMarker: vi.fn(),
    issueLaunch: vi.fn(() => undefined),
  } as unknown as SupervisorRegistry;
}

function makeWindow(overrides: Partial<Window> = {}): Window {
  const tmuxTarget = overrides.tmuxTarget ?? 'proj:win1';
  const colonIdx = tmuxTarget.indexOf(':');
  return {
    id: 1,
    ownerType: 'project',
    projectId: 1,
    taskId: null,
    serverName: 'local-server',
    tmuxTarget,
    muxRef: { kind: 'tmux' as const, workspace: tmuxTarget.slice(0, colonIdx), window: tmuxTarget.slice(colonIdx + 1) },
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
    defaultMux: 'tmux' as const, muxRuntime: 'system', hostProfile: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 10,
    projectId: 1,
    unitId: null,
    serverName: null,
    title: 'test task',
    description: null,
    status: 'implementing',
    currentPhase: 'implementing',
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: false,
    source: 'local',
    sourceRef: null,
    inputTrust: 'trusted',
    createdByKind: 'operator',
    createdById: null,
    createdByGeneration: null,
    targetBranch: null,
    agentSessionId: null,
    taskSummary: null,
    workingDirectory: null,
    skipPr: false,
    pendingFollowUp: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Task;
}

function claudeStrategy(): ISessionStrategy {
  return {
    supportsSession: true,
    needsPostLaunchScan: false,
    buildNewSessionArgs: (id: string) => ['--session-id', id],
    buildResumeArgs: (id: string) => ['--resume', id],
    buildRespawnLaunch: () => null,
    scanSessionId: vi.fn().mockResolvedValue(null),
  };
}

function codexStrategy(): ISessionStrategy {
  return {
    supportsSession: true,
    needsPostLaunchScan: true,
    buildNewSessionArgs: () => [],
    buildResumeArgs: (id: string) => ['--resume', id],
    buildRespawnLaunch: () => null,
    scanSessionId: vi.fn().mockResolvedValue(null),
  };
}

// ─── Tests ───

describe('POST /api/windows/:id/launch-agent — MCP blocking', () => {
  let app: FastifyInstance;
  let window: Window;
  let server: ServerConfig;
  let sendKeys: ReturnType<typeof vi.fn>;
  let replacePaneWithProgram: ReturnType<typeof vi.fn>;
  let taskStore: Map<number, Task>;

  async function buildApp(opts: {
    win: Window;
    srv?: ServerConfig;
    strategy?: ISessionStrategy;
    tasks?: Task[];
    hostProfile?: { platform: 'linux' | 'darwin' | 'win32'; arch: 'x64' | 'arm64' };
  }): Promise<FastifyInstance> {
    window = opts.win;
    server = opts.srv ?? makeServer();
    const strategy = opts.strategy ?? claudeStrategy();
    taskStore = new Map((opts.tasks ?? []).map(t => [t.id, t]));

    sendKeys = vi.fn().mockResolvedValue(undefined);
    replacePaneWithProgram = vi.fn().mockResolvedValue('%1');

    const windowRepo: Partial<IWindowRepository> = {
      findById: (id: number) => (id === window.id ? window : undefined),
      updateAgentSessionIdByWindow: vi.fn(),
    };
    const serverRepo: Partial<IServerRepository> = {
      findByName: (name: string) => (name === server.name ? server : null),
    };
    const mux = {
      sendKeysToHandle: sendKeys as unknown as TmuxClient['sendKeysToHandle'],
      resolvePane: vi.fn().mockResolvedValue('%0') as unknown as TmuxClient['resolvePane'],
      replacePaneWithProgram,
    };
    const respawnService = {
      isTaskExecutionAllowed: vi.fn(() => false),
    };

    const instance = Fastify();
    // The hub's own error mapping, so a host-OS refusal is answered as it is in the app.
    instance.setErrorHandler((err, _request, reply) => {
      const mapped = mapAppError(err);
      if (!mapped) throw err;
      return reply.status(mapped.status).send(mapped.body);
    });
    await instance.register(windowsRoutes, {
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: { findById: (id: number) => taskStore.get(id) ?? null } as unknown as ITaskRepository,
      tmux: mux as unknown as TmuxClient,
      transportFactory: { hostProfileFor: () => opts.hostProfile ?? null, getFileOps: () => ({ platform: opts.hostProfile?.platform ?? 'linux', realpath: async () => 'C:\\Users\\me' }) } as unknown as WindowsRouteOptions['transportFactory'],
      muxDriverRegistry: { resolve: () => mux } as any,
      serverRepo: serverRepo as IServerRepository,
      respawnService: respawnService as unknown as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: { create: () => strategy } as unknown as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowActivityStatusService: { list: async () => [] } as unknown as WindowActivityStatusService,
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
    });
    await instance.ready();
    return instance;
  }

  function sentCommand(): string {
    expect(sendKeys).toHaveBeenCalledTimes(1);
    const [, , keys] = sendKeys.mock.calls[0];
    return keys[0];
  }

  describe('a Windows host (the mux starts the program, nothing is typed)', () => {
    const win32 = { platform: 'win32' as const, arch: 'x64' as const };
    // A Windows host has no tmux: its windows are misao's, which run no supervisor.
    const misaoWindow = (overrides: Partial<Window> = {}): Window => makeWindow({ muxRef: { kind: 'misao', workspace: 'proj', window: 'w_01' }, ...overrides });

    it('replaces the window\'s shell pane with the command split into arguments, in the window\'s directory, with the manual-window env', async () => {
      app = await buildApp({ win: misaoWindow({ workingDirectory: 'C:\\work\\app' }), hostProfile: win32 });
      const res = await app.inject({
        method: 'POST',
        url: `/api/windows/${window.id}/launch-agent`,
        payload: { command: "claude --dangerously-skip-permissions --model 'claude-opus-4-6[1m]'" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, supervised: false });
      expect(sendKeys).not.toHaveBeenCalled();
      expect(replacePaneWithProgram).toHaveBeenCalledTimes(1);
      const [, handle, program] = replacePaneWithProgram.mock.calls[0];
      expect(handle).toBe('%0');
      expect(program).toMatchObject({
        argv: ['claude', '--dangerously-skip-permissions', '--model', 'claude-opus-4-6[1m]', '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/)],
        cwd: 'C:\\work\\app',
        cols: 120,
        rows: 40,
      });
      expect(program.extraEnv).toMatchObject({ AZITO_UI_TOKEN: 'test-token' });
      await app.close();
    });

    it("expands a ~ working directory against the target host's home before it reaches the mux (pane.open does not expand it)", async () => {
      app = await buildApp({ win: misaoWindow({ workingDirectory: '~\\app' }), hostProfile: win32 });
      const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 'claude' } });
      expect(res.statusCode).toBe(200);
      expect(replacePaneWithProgram.mock.calls[0][2]).toMatchObject({ cwd: 'C:\\Users\\me\\app' });
      await app.close();
    });

    it('answers 409 pane_not_replaceable when the mux refuses the replacement (several panes, or a program already runs there)', async () => {
      app = await buildApp({ win: misaoWindow(), hostProfile: win32 });
      replacePaneWithProgram.mockRejectedValue(new PaneReplaceRefusedError('The window has 2 panes'));
      const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 'claude' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'pane_not_replaceable', message: 'The window has 2 panes' });
      await app.close();
    });

    it("refuses a word the Windows shell would read again (a .cmd shim): `claude --model 'a&b'` is unsupported_os, touching nothing", async () => {
      app = await buildApp({ win: misaoWindow(), hostProfile: win32 });
      const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: "claude --model 'a&b'" } });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ code: 'unsupported_os' });
      expect(replacePaneWithProgram).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses a task's primary window like adding a pane (its token generation cannot be given to a replacement pane), touching nothing", async () => {
      app = await buildApp({ win: misaoWindow({ ownerType: 'task', isPrimary: true, taskId: 10 }), hostProfile: win32, tasks: [makeTask({ id: 10 })] });
      const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 'claude --dangerously-skip-permissions' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'primary_task_window_pane_add_unsupported' });
      expect(replacePaneWithProgram).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses a command that cannot be split into arguments safely as unsupported_os (501), touching nothing', async () => {
      app = await buildApp({ win: misaoWindow(), hostProfile: win32 });
      const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 'my-tool | tee log' } });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ code: 'unsupported_os' });
      expect(replacePaneWithProgram).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('(a) isPrimary=true, claude, no session-id → both --strict-mcp-config and --session-id present', async () => {
    app = await buildApp({
      win: makeWindow({ isPrimary: true }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(200);
    const cmd = sentCommand();
    expect(cmd).toContain('--strict-mcp-config');
    expect(cmd).toContain('--session-id');
    await app.close();
  });

  it('(b) isPrimary=true, codex → codex MCP disable flag present', async () => {
    app = await buildApp({
      win: makeWindow({ isPrimary: true, workerType: 'codex' }),
      strategy: codexStrategy(),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'codex --dangerously-bypass-approvals-and-sandbox' },
    });
    expect(res.statusCode).toBe(200);
    const cmd = sentCommand();
    expect(cmd).toContain('-c mcp_servers.azt-mcp.enabled=false');
    await app.close();
  });

  it('(c) isPrimary=false, no task → no MCP block flag', async () => {
    app = await buildApp({
      win: makeWindow({ isPrimary: false, taskId: null }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(200);
    const cmd = sentCommand();
    expect(cmd).not.toContain('--strict-mcp-config');
    await app.close();
  });

  it('(d) isPrimary=false, untrusted task with execution not allowed → MCP block applied', async () => {
    const task = makeTask({ id: 10, inputTrust: 'untrusted' });
    app = await buildApp({
      win: makeWindow({ isPrimary: false, taskId: 10 }),
      tasks: [task],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(200);
    const cmd = sentCommand();
    expect(cmd).toContain('--strict-mcp-config');
    await app.close();
  });

  it('(e) agent server (supervised) → MCP flag survives inside supervisor wrapper', async () => {
    app = await buildApp({
      win: makeWindow({ isPrimary: true }),
      srv: makeServer({ type: 'agent', name: 'local-server', agentPort: 3002, agentToken: 'tok' }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ supervised: true });
    const cmd = sentCommand();
    // The supervisor wraps the inner command; the MCP flag must be inside
    expect(cmd).toContain('azito-supervisor');
    expect(cmd).toContain('--strict-mcp-config');
    await app.close();
  });

  it('MCP flag is not overwritten by session-id append (regression)', async () => {
    // This is the core regression: previously `effectiveCommand = command + flags`
    // used the original `command` and dropped the MCP flag added to `effectiveCommand`.
    app = await buildApp({
      win: makeWindow({ isPrimary: true }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(200);
    const cmd = sentCommand();
    // Both flags must be present in the final command
    expect(cmd).toContain('--session-id');
    expect(cmd).toContain('--strict-mcp-config');
    // The MCP flag must appear after the session-id flags (added last)
    const sessionIdx = cmd.indexOf('--session-id');
    const mcpIdx = cmd.indexOf('--strict-mcp-config');
    expect(mcpIdx).toBeGreaterThan(sessionIdx);
    await app.close();
  });

  it('generic workerType with claude command → MCP block applied', async () => {
    app = await buildApp({
      win: makeWindow({ isPrimary: true, workerType: 'generic' }),
      strategy: { ...claudeStrategy(), supportsSession: false, needsPostLaunchScan: false },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: 'claude --dangerously-skip-permissions' },
    });
    expect(res.statusCode).toBe(200);
    const cmd = sentCommand();
    expect(cmd).toContain('--strict-mcp-config');
    await app.close();
  });
});
