import type { FastifyPluginCallback } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IWindowRepository } from './Window';
import { isPrimaryTaskWindow } from './Window';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import type { ServerConfig } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';
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
import { isSameWindowTarget } from '@azito/shared';
import { muxRefFromTmuxTarget, tmuxTargetFromMuxRef, parseMuxRef, type MuxRef, type PaneOrdinal } from '@azito/shared';
import { resolveWindowById, resolvePaneHandle, killWindowCore, type KillWindowDeps } from './windowPaneOps';
import type { SessionCaptureService } from './SessionCaptureService';
import type { WindowActivityStatusService } from './WindowActivityStatusService';

export interface WindowsRouteOptions {
  windowRepo: IWindowRepository;
  projectRepo: IProjectRepository;
  taskRepo: ITaskRepository;
  tmux: TmuxClient;
  /** Per-server mux driver (herdr / zellij windows); falls back to `tmux` when absent. */
  muxDriverRegistry?: MuxDriverRegistry;
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
  destroyPrimaryTaskWindow?: KillWindowDeps['destroyPrimaryTaskWindow'];
}

const windowsRoutes: FastifyPluginCallback<WindowsRouteOptions> = (fastify, opts, done) => {
  const { windowRepo, projectRepo, taskRepo, tmux, serverRepo, respawnService, sessionStrategyFactory, sessionCaptureService, supervisorRegistry, windowActivityStatusService } = opts;
  const driverFor = (srv: ServerConfig): IMuxClient => (opts.muxDriverRegistry ? opts.muxDriverRegistry.resolve(srv) : tmux);

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
      let tmuxTarget = body['tmux_target'] as string | undefined;
      const refJson = body['ref'] as string | undefined;
      // Keep the driver kind of a supplied ref: deriving mux_ref from tmux_target later would
      // record a herdr / zellij window as `kind: 'tmux'` and break findByServerAndRef.
      let givenRef: MuxRef | undefined;
      if (refJson) {
        try {
          givenRef = parseMuxRef(refJson);
          if (!tmuxTarget) tmuxTarget = tmuxTargetFromMuxRef(givenRef);
        } catch {
          return reply.status(400).send({ error: 'Invalid ref' });
        }
      }
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and (tmux_target or ref) required' });

      const existing = windowRepo.findByServerAndTarget(serverName, tmuxTarget);
      if (existing) {
        if (existing.projectId !== id) {
          windowRepo.update(existing.id, { projectId: id });
          notifyWindowsChanged(serverName);
        }
        return { ok: true, id: existing.id };
      }

      const workerType = (body['worker_type'] as string) || null;
      const workingDirectory = (body['working_directory'] as string) || null;
      const winId = windowRepo.add({
        ownerType: 'project',
        projectId: id,
        taskId: null,
        serverName,
        tmuxTarget,
        ...(givenRef ? { muxRef: givenRef } : {}),
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

      const sessions = await driverFor(srv).listWorkspaces(srv);
      const targetSession = sessions.find((s) => s.name === session);
      if (!targetSession)
        return reply.status(404).send({ error: `Session '${session}' not found on server '${serverName}'` });

      const addedIds: number[] = [];
      for (const win of targetSession.windows) {
        const winTarget = `${session}:${win.name}`;
        const existing = windowRepo.findByServerAndTarget(serverName, winTarget);
        if (existing) {
          if (existing.projectId !== id) windowRepo.update(existing.id, { projectId: id });
          addedIds.push(existing.id);
          continue;
        }
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
      let tmuxTarget = body['tmux_target'] as string | undefined;
      const refJson = body['ref'] as string | undefined;
      // Keep the driver kind of a supplied ref: deriving mux_ref from tmux_target later would
      // record a herdr / zellij window as `kind: 'tmux'` and break findByServerAndRef.
      let givenRef: MuxRef | undefined;
      if (refJson) {
        try {
          givenRef = parseMuxRef(refJson);
          if (!tmuxTarget) tmuxTarget = tmuxTargetFromMuxRef(givenRef);
        } catch {
          return reply.status(400).send({ error: 'Invalid ref' });
        }
      }
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and (tmux_target or ref) required' });

      const existing = windowRepo.findByServerAndTarget(serverName, tmuxTarget);
      if (existing) {
        return { ok: true, id: existing.id };
      }

      const workerType = (body['worker_type'] as string) || null;
      const workingDirectory = (body['working_directory'] as string) || null;
      const winId = windowRepo.add({
        ownerType: 'task',
        projectId: null,
        taskId: id,
        serverName: serverName as string,
        tmuxTarget: tmuxTarget as string,
        ...(givenRef ? { muxRef: givenRef } : {}),
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
      const paneHandle = await driverFor(srv).resolvePane(srv, win.muxRef ?? muxRefFromTmuxTarget(win.tmuxTarget), 1);
      const cmd = supervised
        ? wrapWithSupervisor(effectiveCommand, {
            server: srv,
            target: win.tmuxTarget,
            harnessPrefix: opts.harnessPrefix,
            ...supervisorRegistry.issueLaunch({ serverName: srv.name, target: win.tmuxTarget, taskId: null, unitId: null, windowId: win.id }),
          })
        : effectiveCommand;

      if (supervised) {
        supervisorRegistry.clearExitMarker(srv.name, win.tmuxTarget);
      }
      await driverFor(srv).sendKeysToHandle(srv, paneHandle, [cmd, 'Enter']);
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
      return { ok: true, tmuxTarget: result.tmuxTarget, windowId: id };
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
  fastify.get<{ Querystring: { server_name?: string; tmux_target?: string; windowId?: string } }>(
    '/api/windows/pane-loading-state',
    async (request, reply) => {
      let serverName: string | undefined;
      let tmuxTarget: string | undefined;

      if (request.query.windowId) {
        const win = windowRepo.findById(parseInt(request.query.windowId, 10));
        if (!win) return reply.status(404).send({ error: 'Window not found' });
        serverName = win.serverName;
        tmuxTarget = win.tmuxTarget;
      } else {
        serverName = request.query.server_name;
        tmuxTarget = request.query.tmux_target;
      }

      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'windowId or server_name+tmux_target required' });

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

  // ── DELETE /api/windows/:id/kill ──
  fastify.delete<{ Params: { id: string } }>(
    '/api/windows/:id/kill',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const deps: KillWindowDeps = {
        muxClient: tmux,
        windowRepo,
        destroyPrimaryTaskWindow: opts.destroyPrimaryTaskWindow,
        notifySessionsChanged: notifyWindowsChanged,
      };
      const result = await killWindowCore(deps, srv, ref, win);
      return result;
    },
  );

  // ── PUT /api/windows/:id/rename ──
  fastify.put<{ Params: { id: string } }>(
    '/api/windows/:id/rename',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { name } = request.body as { name?: string };
      if (!name) return reply.status(400).send({ error: 'New name required' });
      await driverFor(srv).renameWindowByRef(srv, ref, name);
      notifyWindowsChanged(win.serverName);
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/panes ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/panes',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      if (win.taskId !== null && isPrimaryTaskWindow(win)) {
        return reply.status(409).send({
          error: 'primary_task_window_pane_add_unsupported',
          message: "Cannot add a pane to a task's primary window directly — respawn the window first, then add panes.",
        });
      }

      const body = request.body as { ordinal?: number; direction?: string };
      const direction = (body.direction || 'v') as 'h' | 'v';
      const ordinal = (body.ordinal ?? 1) as PaneOrdinal;
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      await driverFor(srv).splitPaneByHandle(srv, handle, direction);
      notifyWindowsChanged(win.serverName);
      return { ok: true };
    },
  );

  // ── GET /api/windows/:id/panes/:ordinal/capture ──
  fastify.get<{ Params: { id: string; ordinal: string }; Querystring: { start?: string; end?: string; history?: string } }>(
    '/api/windows/:id/panes/:ordinal/capture',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      const startLine = request.query.start != null ? parseInt(request.query.start, 10) : undefined;
      const endLine = request.query.end != null ? parseInt(request.query.end, 10) : undefined;
      if (startLine == null && endLine == null && request.query.history) {
        const h = parseInt(request.query.history, 10);
        const { stdout } = await driverFor(srv).captureScreen(srv, handle, -h, undefined);
        return { content: stdout };
      }
      const { stdout } = await driverFor(srv).captureScreen(srv, handle, startLine, endLine);
      return { content: stdout };
    },
  );

  // ── POST /api/windows/:id/panes/:ordinal/send-keys ──
  fastify.post<{ Params: { id: string; ordinal: string } }>(
    '/api/windows/:id/panes/:ordinal/send-keys',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      const { keys } = request.body as { keys?: string[] };
      if (!keys || !Array.isArray(keys))
        return reply.status(400).send({ error: 'keys array required' });
      await driverFor(srv).sendKeysToHandle(srv, handle, keys);
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/panes/:ordinal/zoom ──
  fastify.post<{ Params: { id: string; ordinal: string } }>(
    '/api/windows/:id/panes/:ordinal/zoom',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      await driverFor(srv).zoomPaneByHandle(srv, handle);
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/panes/:ordinal/unzoom ──
  fastify.post<{ Params: { id: string; ordinal: string } }>(
    '/api/windows/:id/panes/:ordinal/unzoom',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      await driverFor(srv).unzoomPaneByHandle(srv, handle);
      return { ok: true };
    },
  );

  // ── PUT /api/windows/:id/panes/:ordinal/rename ──
  fastify.put<{ Params: { id: string; ordinal: string } }>(
    '/api/windows/:id/panes/:ordinal/rename',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      const { name } = request.body as { name?: string };
      if (!name) return reply.status(400).send({ error: 'New name required' });
      await driverFor(srv).setPaneTitle(srv, handle, name);
      return { ok: true };
    },
  );

  // ── DELETE /api/windows/:id/panes/:ordinal ──
  fastify.delete<{ Params: { id: string; ordinal: string } }>(
    '/api/windows/:id/panes/:ordinal',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
      await driverFor(srv).closePane(srv, handle);
      notifyWindowsChanged(win.serverName);
      return { ok: true };
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
