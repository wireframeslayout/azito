import { WindowBusyError } from './muxSwitchPolicy';
import { KeyedMutex } from '../../shared/keyedMutex';
import { HostProfileError } from '../../shared/os/hostProfile';
import { mapAppError } from '../../app/mapAppError';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import windowsRoutes from './routes';
import { ConversationCheckError } from '../agents/ConversationCheckError';
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
    labelSource: 'auto',
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
    hostProfile: null, sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null,
  defaultMux: 'tmux' as const, muxRuntime: 'system',
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
  let windowUpdate: ReturnType<typeof vi.fn<IWindowRepository['update']>>;

  beforeEach(async () => {
    window = makeWindow();
    windowUpdate = vi.fn<IWindowRepository['update']>();
    server = makeServer();
    sendKeys = vi.fn().mockResolvedValue(undefined);
    updateByWindowFn = vi.fn<IWindowRepository['updateAgentSessionIdByWindow']>();

    const windowRepo: Partial<IWindowRepository> = {
      findById: (id: number) => (id === window.id ? window : undefined),
      updateAgentSessionIdByWindow: updateByWindowFn,
      findByServerAndTarget: vi.fn(() => undefined), findByServerAndRef: vi.fn(() => undefined),
      add: vi.fn(() => 2), update: windowUpdate,
    };
    const serverRepo: Partial<IServerRepository> = {
      findByName: (name: string) => (name === server.name ? server : null),
    };
    const tmux = {
      sendKeysToHandle: sendKeys as unknown as TmuxClient['sendKeysToHandle'],
      resolvePane: vi.fn().mockResolvedValue('%0') as unknown as TmuxClient['resolvePane'],
      listWorkspaces: vi.fn(async () => [{ name: 's', windows: [] }]),
      renameWindowByRef: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      splitPaneByHandle: vi.fn(async () => ({ result: { code: 0, stdout: '', stderr: '' } })),
      setPaneTitle: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    } as unknown as Partial<TmuxClient>;

    app = Fastify();
    await app.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: { findById: () => ({ id: 1 }) } as unknown as IProjectRepository,
      taskRepo: { findById: () => ({ id: 1 }) } as unknown as ITaskRepository,
      tmux: tmux as TmuxClient,
      muxDriverRegistry: { resolve: () => tmux } as any,
      serverRepo: serverRepo as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: { respawn: vi.fn(async () => ({ tmuxTarget: 'proj:win1' })) } as unknown as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {
        create: () => ({
          supportsSession: true,
          needsPostLaunchScan: false,
          buildNewSessionArgs: (id: string) => ['--session-id', id],
          buildResumeArgs: (id: string) => ['--resume', id],
          buildRespawnLaunch: () => null,
          conversationLogAgentType: null,
          scanSessionId: vi.fn().mockResolvedValue(null),
        }),
      } as unknown as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
    });
    await app.ready();
  });

  it.each([
    ['POST', '/api/projects/1/windows', ['server_name', 'tmux_target', 'ref', 'worker_type', 'worker_model', 'working_directory', 'agent_session_id', 'label', 'window_type', 'launch_command']],
    ['POST', '/api/projects/1/windows/session', ['server_name', 'session', 'kind']],
    ['POST', '/api/tasks/1/windows', ['server_name', 'tmux_target', 'ref', 'label', 'window_type', 'worker_type', 'worker_model', 'working_directory']],
    ['PUT', '/api/windows/1', ['label', 'agent_session_id', 'launch_command', 'worker_model', 'working_directory', 'window_type', 'worker_type']],
    ['POST', '/api/windows/1/launch-agent', ['command', 'force']],
    ['POST', '/api/windows/1/respawn', ['force', 'mux']],
    ['PUT', '/api/windows/1/rename', ['name']],
    ['POST', '/api/windows/1/panes', ['ordinal', 'direction']],
    ['POST', '/api/windows/1/panes/1/send-keys', ['keys']],
    ['PUT', '/api/windows/1/panes/1/rename', ['name']],
  ] as const)('%s %s rejects unknown fields', async (method, url, accepted) => {
    const res = await app.inject({ method, url, payload: { extra: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_fields', unknown: ['extra'], accepted });
  });

  it('keeps the missing keys error and rejects a wrong keys type', async () => {
    const url = '/api/windows/1/panes/1/send-keys';
    const missing = await app.inject({ method: 'POST', url, payload: {} });
    expect(missing.json()).toEqual({ error: 'keys array required' });
    const invalid = await app.inject({ method: 'POST', url, payload: { keys: 'Enter' } });
    expect(invalid.json()).toMatchObject({ error: 'invalid_body' });
  });

  it.each([
    ['POST', '/api/projects/1/windows', { server_name: 'other', tmux_target: 's:w' }],
    ['POST', '/api/projects/1/windows/session', { server_name: 'local-server', session: 's' }],
    ['POST', '/api/tasks/1/windows', { server_name: 'other', tmux_target: 's:w' }],
    ['PUT', '/api/windows/1', { label: null }],
    ['POST', '/api/windows/1/launch-agent', { command: 'claude' }],
    ['POST', '/api/windows/1/respawn', { force: true }],
    ['PUT', '/api/windows/1/rename', { name: 'new' }],
    ['POST', '/api/windows/1/panes', { ordinal: 1, direction: 'v' }],
    ['POST', '/api/windows/1/panes/1/send-keys', { keys: ['Enter'] }],
    ['PUT', '/api/windows/1/panes/1/rename', { name: 'new' }],
  ] as const)('%s %s accepts its body', async (method, url, payload) => {
    const res = await app.inject({ method, url, payload });
    expect(res.statusCode, res.body).toBe(200);
  });

  it.each([
    [{}, {}],
    [{ label: null }, { label: null, labelSource: 'auto' }],
    [{ label: ' new ' }, { label: 'new', labelSource: 'user' }],
    [{ worker_model: null }, { workerModel: null }],
  ])('PUT /api/windows/:id keeps an omitted field apart from a null one (%j)', async (payload, expected) => {
    const res = await app.inject({ method: 'PUT', url: '/api/windows/1', payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(windowUpdate).toHaveBeenCalledWith(1, expected);
  });

  it('reads an omitted or null body as an empty one and rejects an array', async () => {
    const omitted = await app.inject({ method: 'POST', url: '/api/windows/1/respawn' });
    expect(omitted.statusCode, omitted.body).toBe(200);
    const nullBody = await app.inject({ method: 'POST', url: '/api/windows/1/launch-agent', headers: { 'content-type': 'application/json' }, payload: 'null' });
    expect(nullBody.statusCode).toBe(400);
    expect(nullBody.json()).toEqual({ error: 'command required' });
    const array = await app.inject({ method: 'PUT', url: '/api/windows/1/rename', payload: ['new'] });
    expect(array.statusCode).toBe(400);
    expect(array.json()).toMatchObject({ error: 'invalid_body' });
    expect(windowUpdate).not.toHaveBeenCalled();
  });

  it('keeps the existing value errors behind the strict parse', async () => {
    const windowType = await app.inject({ method: 'PUT', url: '/api/windows/1', payload: { window_type: 'other' } });
    expect(windowType.json()).toEqual({ error: 'invalid window_type: other' });
    const kind = await app.inject({ method: 'POST', url: '/api/projects/1/windows/session', payload: { server_name: 'local-server', session: 's', kind: 'herdr' } });
    expect(kind.json()).toEqual({ error: 'Invalid kind' });
    const unknownAndInvalid = await app.inject({ method: 'PUT', url: '/api/windows/1/rename', payload: { name: 1, title: 'x' } });
    expect(unknownAndInvalid.json()).toEqual({ error: 'unknown_fields', unknown: ['title'], accepted: ['name'] });
  });

  it('rejects unknown and invalid launch fields before sending keys', async () => {
    const unknown = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 1, extra: true } });
    expect(unknown.json()).toEqual({ error: 'unknown_fields', unknown: ['extra'], accepted: ['command', 'force'] });
    const invalid = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 1 } });
    expect(invalid.json()).toMatchObject({ error: 'invalid_body', issues: [{ path: 'command' }] });
    expect(sendKeys).not.toHaveBeenCalled();
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
    expect(keys[0]).toMatch(/^export AZITO_WINDOW_ID=\d+; claude --model opus --session-id [0-9a-f-]{36}$/);
  });

  it('gives AZITO_WINDOW_ID to every part of a compound command', async () => {
    window = makeWindow({ windowType: 'terminal' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/windows/${window.id}/launch-agent`,
      payload: { command: `true && sh -c 'printf %s "$AZITO_WINDOW_ID"'` },
    });
    expect(res.statusCode).toBe(200);
    const [, , keys] = sendKeys.mock.calls[0];
    // Run the typed line in a real POSIX shell (env cleared of any inherited value): the command after `&&` must see the id.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('sh', ['-c', keys[0]], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(out).toBe(String(window.id));
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
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: {
        findById: (id: number) => (id === window.id ? window : undefined),
        updateAgentSessionIdByWindow: codexUpdateByWindowFn,
      } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {
        sendKeysToHandle: sendKeys as unknown as TmuxClient['sendKeysToHandle'],
        resolvePane: vi.fn().mockResolvedValue('%0') as unknown as TmuxClient['resolvePane'],
      } as TmuxClient,
      muxDriverRegistry: { resolve: () => ({ sendKeysToHandle: sendKeys, resolvePane: vi.fn().mockResolvedValue('%0') }) } as any,
      serverRepo: {
        findByName: (name: string) => (name === server.name ? server : null),
      } as unknown as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {
        create: () => ({
          supportsSession: true,
          needsPostLaunchScan: true,
          buildNewSessionArgs: () => [],
          buildResumeArgs: (id: string) => ['--resume', id],
          buildRespawnLaunch: () => null,
          conversationLogAgentType: null,
          scanSessionId: vi.fn().mockResolvedValue(null),
        }),
      } as unknown as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
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
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => ({}), availabilityFor: () => ({ available: true }) } as any,
      serverRepo: { findByName: () => makeServer() } as unknown as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(supervisorEntries, exitedTargets),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
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
      lastReportedDecidedBy: null,
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

  async function setup(respawn: WindowRespawnService['respawn'], invalidateSessionCache?: (serverName: string) => void): Promise<FastifyInstance> {
    const windowRepo: Partial<IWindowRepository> = {
      findById: (id: number) => (id === window.id ? window : undefined),
    };
    const serverRepo: Partial<IServerRepository> = {
      findByName: (name: string) => (name === server.name ? server : null),
    };
    const instance = Fastify();
    // The hub's own error mapping, so a host-OS refusal is answered as it is in the app.
    instance.setErrorHandler((err, _request, reply) => { const mapped = mapAppError(err); if (!mapped) throw err; return reply.status(mapped.status).send(mapped.body); });
    await instance.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: windowRepo as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => ({}), availabilityFor: () => ({ available: true }) } as any,
      serverRepo: serverRepo as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: { respawn } as unknown as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
      invalidateSessionCache,
    });
    await instance.ready();
    return instance;
  }

  beforeEach(() => {
    window = makeWindow();
    server = makeServer();
  });

  it('drops the server session cache after a respawn, also when it fails part-way', async () => {
    const invalidate = vi.fn();
    app = await setup(vi.fn(async () => ({ tmuxTarget: 'proj:win1' })), invalidate);
    await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });
    expect(invalidate).toHaveBeenCalledWith(server.name);

    const failing = vi.fn();
    const app2 = await setup(vi.fn(async () => { throw new Error('boom'); }), failing);
    await app2.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });
    expect(failing).toHaveBeenCalledWith(server.name);
  });

  it('answers 501 { error, code: unsupported_os } for a host that cannot run a worker in a pane (Windows, #371)', async () => {
    app = await setup(vi.fn(async () => { throw new HostProfileError('unsupported_os', 'Resuming a worker is not available on Windows hosts yet (tracked in #371).'); }));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'Resuming a worker is not available on Windows hosts yet (tracked in #371).', code: 'unsupported_os' });
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

  it('answers 409 conversation_unverifiable with the reason when the conversation file cannot be checked (#542)', async () => {
    app = await setup(vi.fn(async () => { throw new ConversationCheckError('6f1e3403-aaaa-4bbb-8ccc-0123456789ab', 'agent did not answer'); }));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('agent did not answer'), code: 'conversation_unverifiable', sessionId: '6f1e3403-aaaa-4bbb-8ccc-0123456789ab' });
  });

  it('still succeeds and returns tmuxTarget when the gate allows execution', async () => {
    app = await setup(vi.fn(async () => ({ tmuxTarget: 'proj:win1' })));

    const res = await app.inject({ method: 'POST', url: `/api/windows/${window.id}/respawn` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tmuxTarget: 'proj:win1' });
  });
});

describe('resource check in the answers of launch-agent and respawn (#531)', () => {
  const window = makeWindow();
  const server = makeServer();

  async function setup(check: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
    const tmux: Partial<TmuxClient> = {
      sendKeysToHandle: vi.fn().mockResolvedValue(undefined) as unknown as TmuxClient['sendKeysToHandle'],
      resolvePane: vi.fn().mockResolvedValue('%0') as unknown as TmuxClient['resolvePane'],
    };
    const instance = Fastify();
    await instance.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: { findById: () => window, updateAgentSessionIdByWindow: vi.fn() } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: tmux as TmuxClient,
      muxDriverRegistry: { resolve: () => tmux } as any,
      serverRepo: { findByName: () => server } as unknown as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: { respawn: vi.fn(async () => ({ tmuxTarget: window.tmuxTarget })) } as unknown as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {
        create: () => ({
          supportsSession: true,
          needsPostLaunchScan: false,
          buildNewSessionArgs: (id: string) => ['--session-id', id],
          buildResumeArgs: (id: string) => ['--resume', id],
          buildRespawnLaunch: () => null,
          conversationLogAgentType: null,
          scanSessionId: vi.fn().mockResolvedValue(null),
        }),
      } as unknown as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      resourceGuard: { check } as unknown as import('../servers/resources/ResourceGuard').ResourceGuard,
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
    });
    await instance.ready();
    return instance;
  }

  const routes = [
    { name: 'launch-agent', url: `/api/windows/${window.id}/launch-agent`, payload: { command: 'claude' } },
    { name: 'respawn', url: `/api/windows/${window.id}/respawn`, payload: {} },
  ];

  it.each(routes)('$name says in the answer that the check was skipped, and why', async ({ url, payload }) => {
    const app = await setup(vi.fn(async () => ({ ok: true, skipped: { reason: 'agent_outdated' } })));
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().resourceCheck).toEqual({ skipped: { reason: 'agent_outdated' } });
    await app.close();
  });

  it.each(routes)('$name has no resourceCheck when the check was made', async ({ url, payload }) => {
    const app = await setup(vi.fn(async () => ({ ok: true, skipped: null })));
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('resourceCheck');
    await app.close();
  });
});

describe('GET /api/windows/activity-status (Issue #338 フォロー: process-based liveness supplement)', () => {
  it('proxies the WindowActivityStatusService snapshot as-is', async () => {
    const entries = [
      { windowId: 20, serverName: 'local', target: 'test:win--39vh', status: 'working' as const, projectId: 6 },
    ];
    const app = Fastify();
    await app.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: {} as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => ({}), availabilityFor: () => ({ available: true }) } as any,
      serverRepo: {} as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: vi.fn(() => false), sleep: vi.fn() } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: { list: async () => entries } as unknown as WindowActivityStatusService,
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
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
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: {
        findById: (id: number) => (win && id === win.id ? win : undefined),
      } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => ({}), availabilityFor: () => ({ available: true }) } as any,
      serverRepo: {
        findByName: () => ({ name: 'local-server', type: 'local' }),
      } as unknown as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: {} as WindowRespawnService,
      sleepService: { canSleep: canSleepFn, sleep: sleepFn } as unknown as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: { scheduleInitialScan: vi.fn() } as unknown as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
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

describe('PUT /api/windows/:id/rename', () => {
  it.each([0, 1])('updates the label only when mux returns %i', async (code) => {
    const win = makeWindow();
    const update = vi.fn();
    const app = Fastify();
    await app.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: { findById: () => win, update } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: {} as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => ({ renameWindowByRef: async () => ({ code, stdout: '', stderr: 'failure' }) }) } as any,
      serverRepo: { findByName: () => makeServer() } as unknown as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: {} as WindowRespawnService,
      sleepService: {} as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: {} as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
    });
    const res = await app.inject({ method: 'PUT', url: '/api/windows/1/rename', payload: { name: 'chosen' } });
    expect(res.statusCode).toBe(code === 0 ? 200 : 500);
    if (code === 0) expect(update).toHaveBeenCalledWith(1, { label: 'chosen', labelSource: 'user' });
    else expect(update).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('window label source', () => {
  async function buildApp(win: Window, update: ReturnType<typeof vi.fn>, adoptForTask = vi.fn()) {
    const app = Fastify();
    await app.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      muxSwitchSettingsRepo: {} as never, auditLogService: {} as never, agentActivityMonitor: {} as never,
      harnessPrefix: '',
      windowRepo: {
        findById: () => win, update, adoptForTask,
        findByServerAndRef: () => win, findByServerAndTarget: () => win,
      } as unknown as IWindowRepository,
      projectRepo: {} as IProjectRepository,
      taskRepo: { findById: () => ({ id: 7 }) } as unknown as ITaskRepository,
      tmux: {} as TmuxClient,
      muxDriverRegistry: { resolve: () => ({}), availabilityFor: () => ({ available: true }) } as any,
      serverRepo: { findByName: () => makeServer() } as unknown as IServerRepository,
      transportFactory: { hostProfileFor: () => null },
      respawnService: {} as WindowRespawnService,
      sleepService: {} as WindowSleepService,
      sessionStrategyFactory: {} as ISessionStrategyFactory,
      sessionCaptureService: {} as SessionCaptureService,
      supervisorRegistry: makeSupervisorRegistry(),
      windowSnapshotService: {} as never, windowActivityStatusService: makeWindowActivityStatusService(),
      uiToken: 'test-token', serverIsolationMutex: new KeyedMutex(), buildSecondaryWindowEnv: () => ({}),
    });
    return app;
  }

  function adoptPayload(win: Window) {
    return { server_name: win.serverName, ref: JSON.stringify(win.muxRef), label: 'task-label' };
  }

  it('keeps a user label when a task adopts the window', async () => {
    const win = makeWindow({ ownerType: 'project', taskId: null, label: 'mine', labelSource: 'user' });
    const update = vi.fn();
    const adoptForTask = vi.fn();
    const app = await buildApp(win, update, adoptForTask);
    const res = await app.inject({ method: 'POST', url: '/api/tasks/7/windows', payload: adoptPayload(win) });
    expect(res.statusCode).toBe(200);
    expect(adoptForTask).toHaveBeenCalledWith(win.id, 7);
    expect(update).not.toHaveBeenCalledWith(win.id, expect.objectContaining({ label: expect.anything() }));
    await app.close();
  });

  it('replaces an automatic label when a task adopts the window', async () => {
    const win = makeWindow({ ownerType: 'project', taskId: null, label: 'auto-name', labelSource: 'auto' });
    const update = vi.fn();
    const app = await buildApp(win, update);
    const res = await app.inject({ method: 'POST', url: '/api/tasks/7/windows', payload: adoptPayload(win) });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(win.id, { label: 'task-label' });
    await app.close();
  });

  it.each([
    ['chosen', { label: 'chosen', labelSource: 'user' }],
    ['  ', { label: null, labelSource: 'auto' }],
  ])('PUT /api/windows/:id with label %j records its source', async (label, expected) => {
    const win = makeWindow();
    const update = vi.fn();
    const app = await buildApp(win, update);
    const res = await app.inject({ method: 'PUT', url: `/api/windows/${win.id}`, payload: { label } });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(win.id, expected);
    await app.close();
  });
});

describe('respawn mux API', () => {
  it('validates the body and exposes the wake plan', async () => {
    const app = Fastify();
    const win = makeWindow({ sleeping: true });
    const server = makeServer();
    const respawn = vi.fn().mockResolvedValue({ tmuxTarget: 'proj:replacement' });
    const record = vi.fn(() => { throw new Error('audit failed'); });
    const registry = { availabilityFor: vi.fn(() => ({ available: true } as { available: true } | { available: false; reason: 'daemon_unreachable' })), supportedKinds: () => ['tmux', 'misao'] };
    await app.register(windowsRoutes, {
      paneHandleResolver: {} as never,
      harnessPrefix: '', windowRepo: { findById: () => win } as any,
      projectRepo: {} as any, taskRepo: {} as any, tmux: {} as any,
      muxDriverRegistry: registry as any,
      serverRepo: { findByName: () => server } as any, transportFactory: { hostProfileFor: () => null },
      respawnService: { respawn } as any, sleepService: {} as any, sessionStrategyFactory: {} as any,
      sessionCaptureService: {} as any, supervisorRegistry: {} as any, windowActivityStatusService: {} as any,
      windowSnapshotService: {} as any, uiToken: '', buildSecondaryWindowEnv: () => ({}), serverIsolationMutex: new KeyedMutex(),
      muxSwitchSettingsRepo: { get: () => 'ask' } as any, misaoVersion: async () => '0.3.0', agentActivityMonitor: { snapshot: () => [] } as any,
      auditLogService: { record } as any,
    });
    const plan = await app.inject({ method: 'GET', url: '/api/windows/1/respawn-plan' });
    expect(plan.json()).toMatchObject({ currentMux: 'tmux', misao: { hosted: true, available: true, version: '0.3.0' }, mode: 'ask', shouldAsk: true });
    const bad = await app.inject({ method: 'POST', url: '/api/windows/1/respawn', payload: { mux: 'misao', extra: true } });
    expect(bad.statusCode).toBe(400);
    expect(respawn).not.toHaveBeenCalled();
    registry.availabilityFor.mockReturnValueOnce({ available: false, reason: 'daemon_unreachable' });
    const unavailable = await app.inject({ method: 'POST', url: '/api/windows/1/respawn', payload: { mux: 'misao' } });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toEqual({ error: 'misao_unavailable', reason: 'daemon_unreachable' });
    respawn.mockRejectedValueOnce(new WindowBusyError('window_busy'));
    const busy = await app.inject({ method: 'POST', url: '/api/windows/1/respawn', payload: { mux: 'misao' } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'window_busy' });
    expect(record).not.toHaveBeenCalled();
    const good = await app.inject({ method: 'POST', url: '/api/windows/1/respawn', payload: { mux: 'misao' } });
    expect(good.statusCode).toBe(200);
    expect(respawn).toHaveBeenCalledWith(1, server, expect.objectContaining({ mux: 'misao' }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'window.mux_switched', detail: expect.objectContaining({ trigger: 'manual' }) }));
    await app.close();
  });
});
