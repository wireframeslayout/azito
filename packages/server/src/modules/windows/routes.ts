import type { FastifyPluginCallback } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IWindowRepository } from './Window';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { IServerRepository } from '../servers/Server';
import type { WindowRespawnService } from './WindowRespawnService';
import type { WindowSleepService } from './WindowSleepService';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { ResourceGuard } from '../servers/resources/ResourceGuard';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import { shouldSupervise, wrapWithSupervisor } from '../supervisors/SupervisorLaunch';
import { replyToExecutionGateError } from '../tasks/execution/ExecutionGate';
import { isSameWindowTarget, stripPaneSuffix } from './paneTarget';
import type { SessionCaptureService } from './SessionCaptureService';
import type { WindowActivityStatusService } from './WindowActivityStatusService';

export interface WindowsRouteOptions {
  windowRepo: IWindowRepository;
  projectRepo: IProjectRepository;
  taskRepo: ITaskRepository;
  tmux: TmuxClient;
  serverRepo: IServerRepository;
  respawnService: WindowRespawnService;
  sleepService: WindowSleepService;
  sessionStrategyFactory: ISessionStrategyFactory;
  sessionCaptureService: SessionCaptureService;
  supervisorRegistry: SupervisorRegistry;
  windowActivityStatusService: WindowActivityStatusService;
  notificationBus?: NotificationBus;
  resourceGuard?: ResourceGuard;
  harnessPrefix?: string;
}

const windowsRoutes: FastifyPluginCallback<WindowsRouteOptions> = (fastify, opts, done) => {
  const { windowRepo, projectRepo, taskRepo, tmux, serverRepo, respawnService, sessionStrategyFactory, sessionCaptureService, supervisorRegistry, windowActivityStatusService } = opts;

  function notifyWindowsChanged(serverName: string): void {
    opts.notificationBus?.emit({ type: 'sessions:updated', payload: { serverName } });
  }


  // ── GET /api/projects/:id/windows ──
  fastify.get<{ Params: { id: string } }>(
    '/api/projects/:id/windows',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      return windowRepo.findByProject(id);
    },
  );

  // ── POST /api/projects/:id/windows ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/windows',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      const body = request.body as Record<string, unknown>;
      const serverName = body['server_name'] as string | undefined;
      const tmuxTarget = body['tmux_target'] as string | undefined;
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and tmux_target required' });

      const workerType = (body['worker_type'] as string) || null;
      const workingDirectory = (body['working_directory'] as string) || null;
      const winId = windowRepo.add({
        ownerType: 'project',
        projectId: id,
        taskId: null,
        serverName,
        tmuxTarget,
        label: (body['label'] as string) || null,
        isPrimary: false,
        windowType: (body['window_type'] as string) === 'agent' ? 'agent' : 'terminal',
        workerType,
        workerModel: (body['worker_model'] as string) || null,
        agentSessionId: null,
        launchCommand: (body['launch_command'] as string) || null,
        workingDirectory,
        paneLayout: null,
        sleeping: false,
      });
      sessionCaptureService.scheduleInitialScan(winId, workerType, serverName, workingDirectory);
      notifyWindowsChanged(serverName);
      return { ok: true, id: winId };
    },
  );

  // ── POST /api/projects/:id/windows/session ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/windows/session',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      const body = request.body as Record<string, unknown>;
      const serverName = body['server_name'] as string | undefined;
      const session = body['session'] as string | undefined;
      if (!serverName || !session)
        return reply.status(400).send({ error: 'server_name and session required' });
      const srv = serverRepo.findByName(serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const sessions = await tmux.listSessions(srv);
      const targetSession = sessions.find((s) => s.name === session);
      if (!targetSession)
        return reply.status(404).send({ error: `Session '${session}' not found on server '${serverName}'` });

      const addedIds: number[] = [];
      for (const win of targetSession.windows) {
        const winTarget = `${session}:${win.name}`;
        const winId = windowRepo.add({
          ownerType: 'project',
          projectId: id,
          taskId: null,
          serverName,
          tmuxTarget: winTarget,
          label: win.name || null,
          isPrimary: false,
          windowType: 'terminal',
          workerType: null,
          workerModel: null,
          agentSessionId: null,
          launchCommand: null,
          workingDirectory: null,
          paneLayout: null,
          sleeping: false,
        });
        addedIds.push(winId);
      }
      notifyWindowsChanged(serverName);
      return { ok: true, count: addedIds.length, ids: addedIds };
    },
  );

  // ── GET /api/tasks/:id/windows ──
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id/windows',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!taskRepo.findById(id))
        return reply.status(404).send({ error: 'Task not found' });
      return windowRepo.findByTask(id);
    },
  );

  // ── POST /api/tasks/:id/windows ──
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/windows',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!taskRepo.findById(id))
        return reply.status(404).send({ error: 'Task not found' });
      const body = request.body as Record<string, unknown>;
      const serverName = body['server_name'] as string | undefined;
      const tmuxTarget = body['tmux_target'] as string | undefined;
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and tmux_target required' });

      const workerType = (body['worker_type'] as string) || null;
      const workingDirectory = (body['working_directory'] as string) || null;
      const winId = windowRepo.add({
        ownerType: 'task',
        projectId: null,
        taskId: id,
        serverName: serverName as string,
        tmuxTarget: tmuxTarget as string,
        label: (body['label'] as string) || null,
        isPrimary: false,
        windowType: (body['window_type'] as string) === 'agent' ? 'agent' : 'terminal',
        workerType,
        workerModel: (body['worker_model'] as string) || null,
        agentSessionId: null,
        launchCommand: null,
        workingDirectory,
        paneLayout: null,
        sleeping: false,
      });
      sessionCaptureService.scheduleInitialScan(winId, workerType, serverName as string, workingDirectory);
      notifyWindowsChanged(serverName);
      return { ok: true, id: winId };
    },
  );

  // ── PUT /api/windows/:id ──
  fastify.put<{ Params: { id: string } }>(
    '/api/windows/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const body = request.body as Record<string, unknown>;
      const data: Record<string, unknown> = {};
      if ('label' in body) data['label'] = (body['label'] as string)?.trim() || null;
      if ('agent_session_id' in body) data['agentSessionId'] = body['agent_session_id'];
      if ('launch_command' in body) data['launchCommand'] = body['launch_command'];
      if ('worker_model' in body) data['workerModel'] = body['worker_model'];
      if ('working_directory' in body) data['workingDirectory'] = body['working_directory'];

      if ('window_type' in body || 'worker_type' in body) {
        const windowType = ('window_type' in body ? body['window_type'] : win.windowType) as string;
        if (windowType !== 'terminal' && windowType !== 'agent')
          return reply.status(400).send({ error: `invalid window_type: ${windowType}` });
        const workerType = ('worker_type' in body ? body['worker_type'] : win.workerType) as string | null;
        if (windowType === 'agent' && !workerType)
          return reply.status(400).send({ error: 'worker_type is required when window_type is agent' });
        data['windowType'] = windowType;
        data['workerType'] = windowType === 'terminal' ? null : workerType;
      }

      windowRepo.update(id, data);
      notifyWindowsChanged(win.serverName);
      return { ok: true };
    },
  );

  // ── DELETE /api/windows/:id ──
  fastify.delete<{ Params: { id: string } }>(
    '/api/windows/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });
      windowRepo.removeByServerAndTarget(win.serverName, win.tmuxTarget);
      notifyWindowsChanged(win.serverName);
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/launch-agent ──
  // Manual (task-unrelated) window agent launch. Agent windows (windowType === 'agent')
  // are always wrapped with tui-supervisor on agent servers.
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/launch-agent',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const body = request.body as Record<string, unknown>;
      const command = (body['command'] as string | undefined)?.trim();
      if (!command)
        return reply.status(400).send({ error: 'command required' });

      if (opts.resourceGuard && body['force'] !== true) {
        const status = await opts.resourceGuard.check(srv);
        if (!status.ok)
          return reply.status(409).send({ error: 'insufficient_resources', resources: status });
      }

      const strategy = sessionStrategyFactory.create(win.workerType);
      let effectiveCommand = command;
      if (strategy.supportsSession && !strategy.needsPostLaunchScan) {
        const existingId = /(?:^|\s)--session-id\s+(\S+)/.exec(command)?.[1]
          ?? /(?:^|\s)--resume\s+(\S+)/.exec(command)?.[1];
        if (existingId) {
          windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, existingId);
        } else {
          const sessionId = randomUUID();
          const flags = strategy.buildNewSessionFlags(sessionId);
          if (flags) {
            effectiveCommand = `${command} ${flags}`;
            windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, sessionId);
          }
        }
      }

      const supervised = shouldSupervise(srv.type, win.windowType);
      const paneId = await tmux.resolvePaneId(srv, stripPaneSuffix(win.tmuxTarget));
      const cmd = supervised
        ? wrapWithSupervisor(effectiveCommand, {
            server: srv,
            target: win.tmuxTarget,
            harnessPrefix: opts.harnessPrefix,
            ...supervisorRegistry.issueLaunch({ serverName: srv.name, target: win.tmuxTarget, taskId: null, unitId: null }),
          })
        : effectiveCommand;

      if (supervised) {
        supervisorRegistry.clearExitMarker(srv.name, win.tmuxTarget);
      }
      await tmux.sendKeys(srv, paneId, [cmd, 'Enter']);
      return { ok: true, supervised };
    },
  );

  // ── POST /api/windows/:id/respawn ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/respawn',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const force = (request.body as Record<string, unknown> | null)?.['force'] === true;
      if (opts.resourceGuard && !force) {
        const status = await opts.resourceGuard.check(srv);
        if (!status.ok)
          return reply.status(409).send({ error: 'insufficient_resources', resources: status });
      }

      // respawnService.respawn() runs the untrusted-input execution gate
      // (Issue #328) itself before touching tmux — this route only needs to
      // translate its errors into a response, same as
      // /api/tasks/:id/recover-session and /api/units/:id/execute|follow-up.
      let result: { tmuxTarget: string };
      try {
        result = await respawnService.respawn(id, srv);
      } catch (err) {
        if (replyToExecutionGateError(err, reply)) return;
        throw err;
      }
      notifyWindowsChanged(srv.name);
      return { ok: true, tmuxTarget: result.tmuxTarget };
    },
  );

  // ── POST /api/windows/:id/sleep ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/sleep',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      if (!opts.sleepService.canSleep(win))
        return reply.status(400).send({ error: 'Window cannot be put to sleep: requires agent window with captured session ID and session support' });

      await opts.sleepService.sleep(id);
      notifyWindowsChanged(win.serverName);
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/capture-panes ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/capture-panes',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const layout = await respawnService.capturePaneLayout(srv, win.tmuxTarget);
      windowRepo.updatePaneLayout(id, layout);
      return { ok: true, paneLayout: layout };
    },
  );

  // ── POST /api/windows/:id/capture-session ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/capture-session',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const strategy = sessionStrategyFactory.create(win.workerType);
      if (!strategy.supportsSession)
        return reply.status(400).send({ error: `Worker type '${win.workerType}' does not support session scanning` });

      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const afterTimestamp = win.createdAt ? new Date(win.createdAt + 'Z') : undefined;
      const sessionId = await strategy.scanSessionId(srv, win.workingDirectory, afterTimestamp);
      if (!sessionId)
        return reply.status(404).send({ error: 'No session found' });

      windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, sessionId);
      return { ok: true, agentSessionId: sessionId };
    },
  );

  // ── GET /api/windows/pane-loading-state ──
  // Backs XTermView's loading overlay (see frontend useSupervisedLoadingOverlay). Agent windows
  // are always supervised on agent servers — derived from windowType, not a persisted flag.
  fastify.get<{ Querystring: { server_name?: string; tmux_target?: string } }>(
    '/api/windows/pane-loading-state',
    async (request, reply) => {
      const serverName = request.query.server_name;
      const tmuxTarget = request.query.tmux_target;
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and tmux_target required' });

      const win = windowRepo.findByServerAndTarget(serverName, tmuxTarget);
      const srv = serverRepo.findByName(serverName);
      const isSupervised = win !== undefined && srv !== null && shouldSupervise(srv.type, win.windowType);

      const entry = supervisorRegistry
        .snapshot()
        .find((e) => e.serverName === serverName && isSameWindowTarget(e.target, tmuxTarget));
      if (entry) {
        return { supervised: isSupervised, ready: entry.ready, childCommand: entry.childCommand };
      }

      const recentExit = win ? supervisorRegistry.hasRecentChildExit(serverName, win.tmuxTarget) : false;
      const supervised = isSupervised && !recentExit;

      return { supervised, ready: null, childCommand: win?.launchCommand ?? null };
    },
  );

  // ── GET /api/windows/activity-status ──
  // プロセス実体検査ベースの軽量な稼働判定（Issue #338 フォロー）。hook/tui-supervisor 接続の
  // 有無に関わらず、全 local エージェントウィンドウの working/idle/offline を返す。
  // **診断専用**: 稼働表示の単一ソースは /api/agent-activity（AgentActivityMonitor）であり、
  // この判定はそのラダーの Tier 4 として内部で consult 済み。UI はこの API を参照しない
  // （フロントの並行ポーリング＋加算マージは、上位 Tier の idle を再点灯させるため撤去した）。
  fastify.get('/api/windows/activity-status', async () => windowActivityStatusService.list());

  done();
};

export default windowsRoutes;
