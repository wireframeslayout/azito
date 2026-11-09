import { z } from 'zod';
import { parseWindowId, formatWindowId, asPaneHandle } from '@azito/shared';
import { WindowMessageService } from './WindowMessageService';
import type { PaneHandleResolver } from '../operations/PaneHandleResolver';
import { recordAuditBestEffort } from '../../shared/audit/recordAuditBestEffort';
import { shouldAskMuxSwitch, misaoStatusFor, WindowBusyError, UnsupportedMuxSwitchError } from './muxSwitchPolicy';
import type { SqliteMuxSwitchSettingsRepository } from './SqliteMuxSwitchSettingsRepository';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import type { AgentActivityMonitor } from '../operations/AgentActivityMonitor';
import { OPERATOR_PRINCIPAL } from '../../shared/auth/Principal';
import { windowSnapshotSchema } from './windowSnapshotSchema';
import type { WindowSnapshotService } from './WindowSnapshotService';
import { parseStrictBody } from '../tmux/routes/createBodies';
import { nameBody, keysBody, paneBody } from '../tmux/routes/actionBodies';
import { projectWindowBody, serverWindowBody, projectSessionBody, taskWindowBody, updateWindowBody, launchAgentBody, respawnBody } from './windowBodies';
import type { FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify';
import type { WindowRoleService } from './WindowRoleService';
import { recordAttribution, type Attribution } from '../../shared/attribution';
import { resourceCheckBody, type ResourceGuard, type ResourceUnavailable } from '../servers/resources/ResourceGuard';
import { workerStartsAsProgram } from '../../shared/os/hostFeature';
import { HostProfileError } from '../../shared/os/hostProfile';
import { isAgentSessionId } from '../agents/agentSessionId';
import { shellDialectFor } from '../../shared/os/shellDialect';
import { randomUUID } from 'node:crypto';
import type { IWindowRepository, Window } from './Window';
import type { IProjectRepository } from '../projects/Project';
import type { ITaskRepository } from '../tasks/Task';
import type { ServerConfig } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { KeyedMutex } from '../../shared/keyedMutex';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { IServerRepository } from '../servers/Server';
import type { WindowRespawnService } from './WindowRespawnService';
import type { WindowSleepService } from './WindowSleepService';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { shouldSupervise, wrapWithSupervisor } from '../supervisors/SupervisorLaunch';
import { replyToExecutionGateError } from '../tasks/execution/ExecutionGate';
import { shouldBlockMcp, ensureMcpBlockByCommand } from '../agents/shouldBlockMcp';
import { DuplicateAgentSessionError } from './DuplicateAgentSessionError';
import { isSameWindowTarget, isValidModelId } from '@azito/shared';
import { muxRefFromTmuxTarget, parseMuxRef, type MuxRef, type PaneOrdinal, type MuxDriverKind } from '@azito/shared';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from '../tmux/MuxCapabilityError';
import { muxWindowTarget } from '../tmux/muxWindowTarget';
import { labelAddedWindowOrRemove } from '../tmux/labelRegisteredWindow';
import { kindOfStoredWindow, windowKindOf, persistRenamedWindowLabel } from '../tmux/windowIdentity';
import { AmbiguousWindowKindError, rawTargetProbeOf, resolveRawTarget } from '../tmux/storedWindowKind';
import { resolveWindowById, isRefKindCompatible, resolvePaneHandle, closePaneInWindow, resolvePaneAddEnv, killWindowCore, execResultError, type KillWindowDeps } from './windowPaneOps';
import type { SessionCaptureService } from './SessionCaptureService';
import type { WindowActivityStatusService } from './WindowActivityStatusService';

export interface WindowsRouteOptions {
  attribution: Attribution;
  windowRoles: WindowRoleService;
  paneHandleResolver: PaneHandleResolver;
  muxSwitchSettingsRepo: SqliteMuxSwitchSettingsRepository;
  misaoVersion?: (server: ServerConfig) => Promise<string | undefined>;
  auditLogService: AuditLogService;
  agentActivityMonitor: AgentActivityMonitor;
  windowRepo: IWindowRepository;
  projectRepo: IProjectRepository;
  taskRepo: ITaskRepository;
  tmux: TmuxClient;
  muxDriverRegistry: MuxDriverRegistry;
  serverRepo: IServerRepository;
  /** Tells the OS of a server, hence the shell its panes run (the lines typed into them). */
  transportFactory: Pick<TransportFactory, 'hostProfileFor'>;
  respawnService: WindowRespawnService;
  sleepService: WindowSleepService;
  sessionStrategyFactory: ISessionStrategyFactory;
  sessionCaptureService: SessionCaptureService;
  supervisorRegistry: SupervisorRegistry;
  windowActivityStatusService: WindowActivityStatusService;
  windowSnapshotService: WindowSnapshotService;
  notificationBus?: NotificationBus;
  resourceGuard?: ResourceGuard;
  harnessPrefix: string;
  /** Drops the cached GET /sessions list of a server, so a client re-reading it after a respawn sees the new window. */
  invalidateSessionCache?: (serverName: string) => void;
  destroyPrimaryTaskWindow?: KillWindowDeps['destroyPrimaryTaskWindow'];
  /** Operator UI token a manual pane gets on a non-isolated server. */
  uiToken: string;
  /** Masked-only env of a secondary task-owned window; see SessionsRouteOptions. */
  buildSecondaryWindowEnv: (taskId: number, server: ServerConfig) => Record<string, string>;
  /** The shared per-server mutex (the same instance the sessions and servers routes receive). */
  serverIsolationMutex: KeyedMutex;
}

const windowsRoutes: FastifyPluginCallback<WindowsRouteOptions> = (fastify, opts, done) => {
  const { windowRepo, projectRepo, taskRepo, tmux, serverRepo, respawnService, sessionStrategyFactory, sessionCaptureService, supervisorRegistry, windowActivityStatusService } = opts;
  const driverFor = (srv: ServerConfig): IMuxClient => opts.muxDriverRegistry.resolve(srv);
  /** The registered window's mux (its ref's kind) must be able to serve the server right now. */
  const muxUnavailableBody = (srv: ServerConfig, kind: MuxDriverKind): { error: string; kind: MuxDriverKind; reason: MuxDriverUnavailableReason } | null => {
    const availability = opts.muxDriverRegistry.availabilityFor(kind, srv);
    return availability.available ? null : { error: 'mux_driver_unavailable', kind, reason: availability.reason };
  };

  // Same ceiling as the chat input (transcripts/routes.ts): a long text reaches a non-local tmux pane as one send-keys per 100 characters.
  const MESSAGE_TEXT_MAX_LENGTH = 32768;
  const messageService = new WindowMessageService(windowRepo, taskRepo, serverRepo, opts.muxDriverRegistry, opts.auditLogService);
  const taskAuth = { auth: { classes: ['task' as const] } };
  fastify.get<{ Querystring: { windowId?: string; server?: string; paneHandle?: string } }>('/api/windows/whoami', { config: taskAuth }, async (request, reply) => {
    const { windowId, server, paneHandle } = request.query;
    const principal = request.principal ?? OPERATOR_PRINCIPAL;
    let id: number | null = null;
    if (windowId !== undefined && !server && !paneHandle) id = parseWindowId(windowId);
    else if (windowId === undefined && paneHandle) {
      const task = principal.class === 'task' && principal.id !== undefined ? taskRepo.findById(principal.id) : null;
      const taskServer = task?.serverName ?? (task ? windowRepo.findByTask(task.id).find((w) => w.isPrimary)?.serverName : undefined);
      const resolvedServer = principal.class === 'task' ? taskServer : server;
      if (!resolvedServer) return principal.class === 'operator' ? reply.status(400).send({ error: 'server is required' }) : reply.status(404).send({ error: 'Cannot resolve task server' });
      id = (await opts.paneHandleResolver.resolveWindowByPaneHandle(resolvedServer, asPaneHandle(paneHandle), { fresh: true }))?.windowId ?? null;
    } else return reply.status(400).send({ error: 'Invalid identity query' });
    const win = id === null ? undefined : windowRepo.findById(id);
    if (!win) return reply.status(404).send({ error: 'Window not found' });
    if (principal.class === 'task' && (win.ownerType !== 'task' || win.taskId !== principal.id)) return reply.status(403).send({ error: 'Forbidden' });
    if (principal.class !== 'task' && principal.class !== 'operator') return reply.status(403).send({ error: 'Forbidden' });
    return { windowId: win.id, idLabel: formatWindowId(win.id), taskId: win.taskId, serverName: win.serverName };
  });
  fastify.post<{ Params: { id: string } }>('/api/windows/:id/messages', { config: taskAuth }, async (request, reply) => {
    const id = parseWindowId(request.params.id);
    const body = z.object({ from: z.object({ windowId: z.number().int().positive().safe() }).strict().optional(), text: z.string().min(1).max(MESSAGE_TEXT_MAX_LENGTH) }).strict().safeParse(request.body);
    if (id === null || !body.success) return reply.status(400).send({ error: 'Invalid message' });
    const result = await messageService.send(request.principal ?? OPERATOR_PRINCIPAL, id, body.data.from?.windowId, body.data.text, (err) => request.log.error({ err }, 'Message audit failed'), (err) => request.log.error({ err }, 'Message delivery failed'));
    if (result === 'not_found') return reply.status(404).send({ error: 'Window not found' });
    if (result === 'forbidden') return reply.status(403).send({ error: 'Forbidden' });
    if (result === 'sleeping') return reply.status(409).send({ error: 'Window is sleeping' });
    if (result === 'send_failed') return reply.status(502).send({ error: 'Message delivery failed; it may have been partially delivered' });
    if (typeof result === 'object') return reply.status(result.code === 'invalid_control_character' ? 400 : 409).send({ error: result.error });
    recordAttribution(request, opts.attribution, { windowId: id });
    return { ok: true };
  });

  fastify.put<{ Params: { id: string } }>('/api/windows/:id/role', async (request, reply) => {
    const id = parseWindowId(request.params.id);
    const body = z.object({ role: z.enum(['orchestrator']).nullable() }).strict().safeParse(request.body);
    if (id === null || !body.success) return reply.status(400).send({ error: 'invalid_role' });
    const result = opts.windowRoles.set(id, body.data.role);
    if (result !== 'ok') return reply.status(result === 'not_found' ? 404 : 409).send({ error: result });
    return { ok: true };
  });

  fastify.get('/api/windows/snapshots', async (request, reply) => {
    const query = windowSnapshotSchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'Invalid snapshot query' });
    return { snapshots: await opts.windowSnapshotService.capture(query.data.ids, query.data.lines, query.data.since) };
  });

  // Issue #471: resolve a task's execution-allowed status for the MCP
  // blocking decision. Delegates to respawnService.isTaskExecutionAllowed()
  // which has the full ExecutionGate dependencies.
  const resolveLinkedTaskForMcp = (taskId: number, serverName: string): { executionAllowed: boolean } | 'unknown' => {
    try {
      const task = taskRepo.findById(taskId);
      if (!task) return 'unknown';
      if (task.inputTrust !== 'untrusted') return { executionAllowed: true };
      return { executionAllowed: respawnService.isTaskExecutionAllowed(task, serverName) };
    } catch {
      return 'unknown';
    }
  };

  // A row whose panes could not be labelled is removed so a retry registers (and labels) it again.
  const labelOrRemoveWindow = (srv: ServerConfig, ref: MuxRef, windowId: number, taskId?: number): Promise<void> =>
    labelAddedWindowOrRemove(driverFor(srv), srv, ref, { windowId, ...(taskId !== undefined ? { taskId } : {}) }, windowRepo);

  // One physical window = one row. The ref is the window's identity (a unique index covers it), the tmux_target is
  // only a display/legacy key that differs between `ws:w_<id>` (ref-only registration) and `ws:<name>`; so a given
  // ref decides first and the target is consulted only when no ref was sent or no row carries it.
  /**
   * The mux of a registration that carries no ref: a registered window's row decides; otherwise the mux of the server
   * that has the window (tmux when none does: the window may not exist yet). A window in both muxes is an error.
   */
  const probe = rawTargetProbeOf(opts.muxDriverRegistry);
  const rawRegistrationKind = async (srv: ServerConfig, target: string): Promise<{ kind: MuxDriverKind } | { error: string } | { unavailable: { error: string; kind: MuxDriverKind; reason: MuxDriverUnavailableReason } }> => {
    const stored = windowRepo.findByServerAndTarget(srv.name, target);
    if (stored) return { kind: kindOfStoredWindow(stored) };
    try {
      const found = await resolveRawTarget(probe, srv, target);
      if (found) return { kind: found.kind };
    } catch (err) {
      if (err instanceof AmbiguousWindowKindError) return { error: 'The target names a window in more than one mux; ref required' };
      // A mux that cannot be asked may hold the window: it is not registered as tmux on a guess.
      if (err instanceof MuxDriverUnavailableError) return { unavailable: { error: 'mux_driver_unavailable', kind: err.kind, reason: err.reason } };
      throw err;
    }
    const kinds = probe.supportedKinds(srv);
    return { kind: kinds.includes('tmux') ? 'tmux' : kinds[0] };
  };

  function findExistingWindow(serverName: string, tmuxTarget: string, givenRef: MuxRef | undefined): Window | undefined {
    return (givenRef ? windowRepo.findByServerAndRef(serverName, givenRef) : undefined)
      ?? windowRepo.findByServerAndTarget(serverName, tmuxTarget);
  }

  function notifyWindowsChanged(serverName: string): void {
    opts.invalidateSessionCache?.(serverName);
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
  const registerWindow = async (request: FastifyRequest<{ Params: { id?: string } }>, reply: FastifyReply) => {
      const id = request.params.id === undefined ? null : parseInt(request.params.id, 10);
      if (id !== null && !projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      const parsedBody = parseStrictBody(id === null ? serverWindowBody : projectWindowBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const body = parsedBody.data;
      const serverName = body.server_name;
      let tmuxTarget = body.tmux_target;
      const refJson = body.ref;
      const srv = serverName ? serverRepo.findByName(serverName) : null;
      let givenRef: MuxRef | undefined;
      if (refJson) {
        try {
          givenRef = parseMuxRef(refJson);
          if (!isRefKindCompatible(givenRef, srv)) throw new Error('ref kind does not match server');
          // A misao window is stored as `<workspace>:<window id>`: a display name or an ordinal sent as the target
          // would name another window once windows are renamed or closed (and could collide with a tmux window).
          if (!tmuxTarget || givenRef.kind === 'misao') tmuxTarget = muxWindowTarget(givenRef);
        } catch {
          return reply.status(400).send({ error: 'Invalid ref' });
        }
      }
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and (tmux_target or ref) required' });
      // A name-only target cannot identify a window on a non-tmux mux; storing it would write a tmux-kind mux_ref.
      // Its mux is the registered row's, else the one that has the window (a local server hosts both; see resolveRawTarget).
      let rawKind: MuxDriverKind | undefined;
      if (!givenRef && srv) {
        const raw = await rawRegistrationKind(srv, tmuxTarget);
        if ('unavailable' in raw) return reply.status(400).send(raw.unavailable);
        if ('error' in raw) return reply.status(400).send({ error: raw.error });
        rawKind = raw.kind;
        if (rawKind !== 'tmux') return reply.status(400).send({ error: 'ref required for this server' });
      }
      const unavailable = srv && (givenRef?.kind ?? rawKind) ? muxUnavailableBody(srv, (givenRef?.kind ?? rawKind)!) : null;
      if (unavailable) return reply.status(400).send(unavailable);

      const role = id === null ? serverWindowBody.parse(request.body).role ?? null : null;
      if (role && (body.window_type !== 'agent' || !body.worker_type)) return reply.status(409).send({ error: 'not_agent_window' });
      const existing = findExistingWindow(serverName, tmuxTarget, givenRef);
      if (existing) {
        if (role && existing.role !== role) return reply.status(409).send({ error: 'already_registered', windowId: existing.id });
        if (id !== null && existing.ownerType !== 'server' && existing.projectId !== id) {
          windowRepo.update(existing.id, { projectId: id });
          notifyWindowsChanged(serverName);
        }
        return { ok: true, id: existing.id };
      }

      const workerType = body.worker_type || null;
      const workerModel = body.worker_model || null;
      if (workerModel && !isValidModelId(workerModel)) {
        return reply.code(400).send({ error: 'Invalid worker_model format' });
      }
      const workingDirectory = body.working_directory || null;
      // The session id a Windows host's agent was started with (it is the window's first pane, so no launch-agent call records it).
      const agentSessionId = body.agent_session_id || null;
      if (agentSessionId !== null && !isAgentSessionId(agentSessionId)) {
        return reply.code(400).send({ error: 'Invalid agent_session_id format' });
      }
      const winId = windowRepo.add({
        ownerType: id === null ? 'server' : 'project', role, originProjectId: null,
        projectId: id,
        taskId: null,
        serverName,
        tmuxTarget,
        ...(givenRef ? { muxRef: givenRef } : {}),
        label: body.label || null,
        isPrimary: false,
        windowType: body.window_type === 'agent' ? 'agent' : 'terminal',
        workerType,
        workerModel,
        agentSessionId,
        launchCommand: body.launch_command || null,
        workingDirectory,
        paneLayout: null,
        sleeping: false,
      });
      if (givenRef && srv) await labelOrRemoveWindow(srv, givenRef, winId);
      sessionCaptureService.scheduleInitialScan(winId, workerType, serverName, workingDirectory);
      notifyWindowsChanged(serverName);
      return { ok: true, id: winId };
    };
  fastify.post<{ Params: { id: string } }>('/api/projects/:id/windows', registerWindow);
  fastify.post('/api/windows', registerWindow);

  // ── POST /api/projects/:id/windows/session ──
  fastify.post<{ Params: { id: string } }>(
    '/api/projects/:id/windows/session',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!projectRepo.findById(id))
        return reply.status(404).send({ error: 'Project not found' });
      const parsedBody = parseStrictBody(projectSessionBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const body = parsedBody.data;
      const serverName = body.server_name;
      const session = body.session;
      if (!serverName || !session)
        return reply.status(400).send({ error: 'server_name and session required' });
      const srv = serverRepo.findByName(serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      // A tmux and a misao session can share a name: `kind` picks one (omitted = the server's default mux).
      const kindParam = body.kind;
      if (kindParam !== undefined && kindParam !== 'tmux' && kindParam !== 'misao')
        return reply.status(400).send({ error: 'Invalid kind' });
      const kind: MuxDriverKind = kindParam ?? srv.defaultMux;

      const sessions = await driverFor(srv).listWorkspaces(srv);
      const targetSession = sessions.find((s) => s.name === session && (s.kind ?? srv.defaultMux) === kind);
      if (!targetSession)
        return reply.status(404).send({ error: `Session '${session}' not found on server '${serverName}'` });

      const addedIds: number[] = [];
      for (const win of targetSession.windows) {
        // tmux: the window name; misao: the window id (a display name is not an identity, M-023).
        const winTarget = win.ref?.kind === 'misao' ? muxWindowTarget(win.ref) : `${session}:${win.name}`;
        const existing = findExistingWindow(serverName, winTarget, win.ref);
        if (existing) {
          if (existing.ownerType !== 'server' && existing.projectId !== id) {
            windowRepo.update(existing.id, { projectId: id });
            notifyWindowsChanged(serverName);
          }
          addedIds.push(existing.id);
          continue;
        }
        const winId = windowRepo.add({
          ownerType: 'project', role: null, originProjectId: null,
          projectId: id,
          taskId: null,
          serverName,
          tmuxTarget: winTarget,
          ...(win.ref ? { muxRef: win.ref } : {}),
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
        if (win.ref) await labelOrRemoveWindow(srv, win.ref, winId);
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
      const parsedBody = parseStrictBody(taskWindowBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const body = parsedBody.data;
      const serverName = body.server_name;
      let tmuxTarget = body.tmux_target;
      const refJson = body.ref;
      const srv = serverName ? serverRepo.findByName(serverName) : null;
      let givenRef: MuxRef | undefined;
      if (refJson) {
        try {
          givenRef = parseMuxRef(refJson);
          if (!isRefKindCompatible(givenRef, srv)) throw new Error('ref kind does not match server');
          // A misao window is stored as `<workspace>:<window id>`: a display name or an ordinal sent as the target
          // would name another window once windows are renamed or closed (and could collide with a tmux window).
          if (!tmuxTarget || givenRef.kind === 'misao') tmuxTarget = muxWindowTarget(givenRef);
        } catch {
          return reply.status(400).send({ error: 'Invalid ref' });
        }
      }
      if (!serverName || !tmuxTarget)
        return reply.status(400).send({ error: 'server_name and (tmux_target or ref) required' });
      // A name-only target cannot identify a window on a non-tmux mux; storing it would write a tmux-kind mux_ref.
      // Its mux is the registered row's, else the one that has the window (a local server hosts both; see resolveRawTarget).
      let rawKind: MuxDriverKind | undefined;
      if (!givenRef && srv) {
        const raw = await rawRegistrationKind(srv, tmuxTarget);
        if ('unavailable' in raw) return reply.status(400).send(raw.unavailable);
        if ('error' in raw) return reply.status(400).send({ error: raw.error });
        rawKind = raw.kind;
        if (rawKind !== 'tmux') return reply.status(400).send({ error: 'ref required for this server' });
      }
      const unavailable = srv && (givenRef?.kind ?? rawKind) ? muxUnavailableBody(srv, (givenRef?.kind ?? rawKind)!) : null;
      if (unavailable) return reply.status(400).send(unavailable);

      const existing = findExistingWindow(serverName, tmuxTarget, givenRef);
      if (existing) {
        // One physical window = one row (migration 068). The Add Window flow registers the
        // window as a project window first and then attaches it here; returning the row
        // untouched left it project-owned, so the task never got the window (win--qvp6 /
        // task 368, three times). Convert ownership instead.
        if (existing.ownerType === 'task' && existing.taskId != null && existing.taskId !== id) {
          return reply.status(409).send({ error: `Window already belongs to task ${existing.taskId}`, windowId: existing.id, taskId: existing.taskId });
        }
        if (existing.ownerType !== 'task' || existing.taskId !== id) {
          if (existing.role === 'orchestrator') return reply.status(409).send({ error: 'orchestrator_window' });
          windowRepo.adoptForTask(existing.id, id);
          // A label the user set (rename) outlives the adoption; only an automatic one is replaced.
          const label = existing.labelSource === 'user' ? undefined : body.label || undefined;
          const windowType = body.window_type === 'agent' ? 'agent' as const : undefined;
          if (label || windowType) windowRepo.update(existing.id, { ...(label ? { label } : {}), ...(windowType ? { windowType } : {}) });
          return { ok: true, id: existing.id, adopted: true, tmuxTarget: existing.tmuxTarget };
        }
        return { ok: true, id: existing.id, tmuxTarget: existing.tmuxTarget };
      }

      if (body.worker_model && !isValidModelId(body.worker_model)) {
        return reply.code(400).send({ error: 'Invalid worker_model format' });
      }
      const workerType = body.worker_type || null;
      const workingDirectory = body.working_directory || null;
      const winId = windowRepo.add({
        ownerType: 'task', role: null, originProjectId: null,
        projectId: null,
        taskId: id,
        serverName,
        tmuxTarget,
        ...(givenRef ? { muxRef: givenRef } : {}),
        label: body.label || null,
        isPrimary: false,
        windowType: body.window_type === 'agent' ? 'agent' : 'terminal',
        workerType,
        workerModel: body.worker_model || null,
        agentSessionId: null,
        launchCommand: null,
        workingDirectory,
        paneLayout: null,
        sleeping: false,
      });
      if (givenRef && srv) await labelOrRemoveWindow(srv, givenRef, winId, id);
      sessionCaptureService.scheduleInitialScan(winId, workerType, serverName, workingDirectory);
      notifyWindowsChanged(serverName);
      return { ok: true, id: winId, tmuxTarget };
    },
  );

  // ── PUT /api/windows/:id ──
  fastify.put<{ Params: { id: string } }>(
    '/api/windows/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const parsedBody = parseStrictBody(updateWindowBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const body = parsedBody.data;
      const data: Record<string, unknown> = {};
      if ('label' in body) {
        // The label edit is the user's own; clearing it hands the title back to the automatic sources.
        const label = body.label?.trim() || null;
        data['label'] = label;
        data['labelSource'] = label ? 'user' : 'auto';
      }
      if ('agent_session_id' in body) data['agentSessionId'] = body.agent_session_id;
      if ('launch_command' in body) data['launchCommand'] = body.launch_command;
      if ('worker_model' in body) {
        if (body.worker_model && !isValidModelId(body.worker_model)) {
          return reply.code(400).send({ error: 'Invalid worker_model format' });
        }
        data['workerModel'] = body.worker_model;
      }
      if ('working_directory' in body) data['workingDirectory'] = body.working_directory;

      if ('window_type' in body || 'worker_type' in body) {
        const windowType = 'window_type' in body ? body.window_type : win.windowType;
        if (windowType !== 'terminal' && windowType !== 'agent')
          return reply.status(400).send({ error: `invalid window_type: ${windowType}` });
        const workerType = 'worker_type' in body ? body.worker_type : win.workerType;
        if (win.role === 'orchestrator' && windowType !== 'agent') return reply.status(409).send({ error: 'orchestrator_window' });
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
      // A Windows host starts an agent as the first pane of its window, not by typing into a shell pane (POST /mux/workspaces with `launch`),
      // so an agent cannot be started in a window that already exists: its shell pane would have to be replaced, and what runs in it could be lost.
      if (workerStartsAsProgram(opts.transportFactory.hostProfileFor(srv))) {
        throw new HostProfileError('unsupported_os', 'Launching an agent in an existing window is not available on Windows hosts: an agent is started in a new window (the window is created with the agent as its first pane).');
      }

      const parsedBody = parseStrictBody(launchAgentBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const body = parsedBody.data;
      const command = body.command?.trim();
      if (!command)
        return reply.status(400).send({ error: 'command required' });

      let resourceSkipped: ResourceUnavailable | null = null;
      if (opts.resourceGuard && body.force !== true) {
        const status = await opts.resourceGuard.check(srv);
        if (!status.ok)
          return reply.status(409).send({ error: 'insufficient_resources', resources: status });
        resourceSkipped = status.skipped;
      }

      // Issue #471: enforce MCP blocking for task worker windows, but not
      // user-added windows. The command from the frontend was built without
      // MCP flags (listAgentDefinitions now returns unblocked commands), so
      // we must add them when the window requires blocking.
      const blockMcp = shouldBlockMcp({
        isPrimary: win.isPrimary,
        linkedTask: win.taskId !== null ? resolveLinkedTaskForMcp(win.taskId, win.serverName) : null,
      });

      const strategy = sessionStrategyFactory.create(win.workerType);
      let effectiveCommand = command;

      // Session ID processing first (operates on the original command)
      if (strategy.supportsSession && !strategy.needsPostLaunchScan) {
        const existingId = /(?:^|\s)--session-id\s+(\S+)/.exec(effectiveCommand)?.[1]
          ?? /(?:^|\s)--resume\s+(\S+)/.exec(effectiveCommand)?.[1];
        if (existingId) {
          windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, existingId);
        } else {
          const sessionId = randomUUID();
          const sessionArgs = strategy.buildNewSessionArgs(sessionId);
          if (sessionArgs.length > 0) {
            effectiveCommand = `${effectiveCommand} ${sessionArgs.join(' ')}`;
            windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, sessionId);
          }
        }
      }

      // MCP flag injection last (just before supervisor wrapping) so it
      // is never overwritten by the session-id append above.
      if (blockMcp) {
        effectiveCommand = ensureMcpBlockByCommand(effectiveCommand);
      }

      const supervised = shouldSupervise(srv.type, win.windowType, windowKindOf(win));
      const paneRef = win.muxRef ?? muxRefFromTmuxTarget(win.tmuxTarget);
      const paneHandle = await driverFor(srv).resolvePane(srv, paneRef, 1);
      const cmd = supervised
        ? wrapWithSupervisor(effectiveCommand, {
            server: srv,
            dialect: shellDialectFor(opts.transportFactory.hostProfileFor(srv)),
            target: win.tmuxTarget,
            harnessPrefix: opts.harnessPrefix,
            ...supervisorRegistry.issueLaunch({ serverName: srv.name, target: win.tmuxTarget, taskId: null, unitId: null, windowId: win.id }),
          })
        : effectiveCommand;

      if (supervised) {
        supervisorRegistry.clearExitMarker(srv.name, win.tmuxTarget);
      }
      // Exported into the pane's shell (a POSIX one: Windows hosts are refused above) rather than prefixed onto the command, so every
      // part of a compound command (`cd x && claude`) sees it; the pane belongs to this window, so the value stays right afterwards too.
      await driverFor(srv).sendKeysToHandle(srv, paneHandle, [`export AZITO_WINDOW_ID=${win.id}; ${cmd}`, 'Enter']);
      return { ok: true, supervised, ...resourceCheckBody(resourceSkipped) };
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/windows/:id/respawn-plan', async (request, reply) => {
    const win = windowRepo.findById(Number(request.params.id));
    if (!win) return reply.status(404).send({ error: 'Window not found' });
    const server = serverRepo.findByName(win.serverName);
    if (!server) return reply.status(404).send({ error: 'Server not found' });
    const kind = windowKindOf(win);
    const status = misaoStatusFor(opts.muxDriverRegistry, server);
    const version = status.available ? await opts.misaoVersion?.(server) : undefined;
    const misao = { ...status, ...(version ? { version } : {}) };
    const mode = opts.muxSwitchSettingsRepo.get();
    return { serverName: server.name, currentMux: kind, misao, mode, shouldAsk: shouldAskMuxSwitch(kind, mode, misao.available) };
  });

  // ── POST /api/windows/:id/respawn ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/respawn',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const win = windowRepo.findById(id);
      if (!win) return reply.status(404).send({ error: 'Window not found' });

      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const parsedBody = parseStrictBody(respawnBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const { force, mux } = parsedBody.data;
      const sourceMux = windowKindOf(win);
      if (sourceMux === 'misao' && mux === 'tmux') return reply.status(400).send({ error: 'unsupported_switch' });
      if (mux === 'misao') {
        const status = misaoStatusFor(opts.muxDriverRegistry, srv);
        if (!status.available) return reply.status(409).send({ error: 'misao_unavailable', reason: status.reason });
      }

      let resourceSkipped: ResourceUnavailable | null = null;
      if (opts.resourceGuard && !force) {
        const status = await opts.resourceGuard.check(srv);
        if (!status.ok)
          return reply.status(409).send({ error: 'insufficient_resources', resources: status });
        resourceSkipped = status.skipped;
      }

      // respawnService.respawn() runs the untrusted-input execution gate
      // (Issue #328) itself before touching tmux — this route only needs to
      // translate its errors into a response, same as
      // /api/tasks/:id/recover-session and /api/units/:id/execute|follow-up.
      let result: { tmuxTarget: string };
      try {
        result = await respawnService.respawn(id, srv, { mux, isBusy: (windowId) => opts.agentActivityMonitor.snapshot().some((entry) => entry.windowId === windowId || (entry.serverName === win.serverName && isSameWindowTarget(entry.target, win.tmuxTarget))) });
        if (mux && mux !== sourceMux) {
          const actor = request.principal ?? OPERATOR_PRINCIPAL;
          recordAuditBestEffort(opts.auditLogService, { actorClass: actor.class, actorId: actor.id ?? null, event: 'window.mux_switched', detail: { windowId: id, serverName: srv.name, from: sourceMux, to: mux, trigger: 'manual' } }, (err) => request.log.error({ err, windowId: id }, 'Mux switch audit failed'));
        }
      } catch (err) {
        if (replyToExecutionGateError(err, reply)) return;
        if (err instanceof MuxDriverUnavailableError && err.kind === 'misao') return reply.status(409).send({ error: 'misao_unavailable', reason: err.reason });
        if (err instanceof WindowBusyError) return reply.status(409).send({ error: 'window_busy' });
        if (err instanceof UnsupportedMuxSwitchError) return reply.status(400).send({ error: 'unsupported_switch' });
        if (err instanceof DuplicateAgentSessionError) {
          return reply.status(409).send({ error: 'session_already_running', windowId: err.windowId, sessionId: err.sessionId, message: err.message });
        }
        throw err;
      } finally {
        // respawn() can fail after it already switched the window (pane labelling), so the cached
        // list is dropped whatever the outcome; only a clean finish is announced below.
        opts.invalidateSessionCache?.(srv.name);
      }
      notifyWindowsChanged(srv.name);
      return { ok: true, tmuxTarget: result.tmuxTarget, windowId: id, ...resourceCheckBody(resourceSkipped) };
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
      const isSupervised = win !== undefined && srv !== null && shouldSupervise(srv.type, win.windowType, windowKindOf(win));

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
        muxClient: driverFor(srv),
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
      const parsedBody = parseStrictBody(nameBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const { name } = parsedBody.data;
      if (!name) return reply.status(400).send({ error: 'New name required' });
      const result = await driverFor(srv).renameWindowByRef(srv, ref, name);
      const err = execResultError(result);
      if (err) return reply.status(err.status).send({ error: err.error });
      if (!persistRenamedWindowLabel(() => windowRepo.update(win.id, { label: name, labelSource: 'user' }), () => notifyWindowsChanged(win.serverName), request.log, win.id)) {
        return reply.status(500).send({ error: 'Window renamed, but saving its label failed' });
      }
      notifyWindowsChanged(win.serverName);
      opts.notificationBus?.emit({ type: 'window:renamed', payload: { serverName: win.serverName, target: win.tmuxTarget, newName: name, windowId: win.id } });
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/focus ──
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/focus',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      await driverFor(srv).focusWindow(srv, ref);
      return { ok: true };
    },
  );

  // ── POST /api/windows/:id/panes ──
  // The window and server rows, the primary/secondary task-window decision, the env and the split all run inside
  // the per-server lock (see serverIsolationMutex's doc comment on SessionsRouteOptions), against rows fetched in it.
  fastify.post<{ Params: { id: string } }>(
    '/api/windows/:id/panes',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const serverName = resolveWindowById(windowRepo, id).window.serverName;
      return opts.serverIsolationMutex.withLock(serverName, async () => {
        const { window: win, ref } = resolveWindowById(windowRepo, id);
        const srv = serverRepo.findByName(win.serverName);
        if (!srv) return reply.status(404).send({ error: 'Server not found' });

        const paneEnv = resolvePaneAddEnv(win, srv, { uiToken: opts.uiToken, buildSecondaryWindowEnv: opts.buildSecondaryWindowEnv });
        if (!paneEnv.ok) return reply.status(paneEnv.status).send(paneEnv.body);

        const parsedBody = parseStrictBody(paneBody, request.body);
        if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
        const body = parsedBody.data;
        const direction = (body.direction || 'v') as 'h' | 'v';
        const ordinal = (body.ordinal ?? 1) as PaneOrdinal;
        const handle = await resolvePaneHandle(driverFor(srv), srv, ref, ordinal);
        const { result } = await driverFor(srv).splitPaneByHandle(srv, handle, direction, paneEnv.extraEnv);
        const err = execResultError(result);
        if (err) return reply.status(err.status).send({ error: err.error });
        notifyWindowsChanged(win.serverName);
        return { ok: true };
      });
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
        recordAttribution(request, opts.attribution, { windowId: id });
        return { content: stdout };
      }
      const { stdout } = await driverFor(srv).captureScreen(srv, handle, startLine, endLine);
      recordAttribution(request, opts.attribution, { windowId: id });
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
      const parsedBody = parseStrictBody(keysBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const { keys } = parsedBody.data;
      if (!keys || !Array.isArray(keys))
        return reply.status(400).send({ error: 'keys array required' });
      await driverFor(srv).sendKeysToHandle(srv, handle, keys);
      recordAttribution(request, opts.attribution, { windowId: id });
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
      const result = await driverFor(srv).zoomPaneByHandle(srv, handle);
      const err = execResultError(result);
      if (err) return reply.status(err.status).send({ error: err.error });
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
      const result = await driverFor(srv).unzoomPaneByHandle(srv, handle);
      const err = execResultError(result);
      if (err) return reply.status(err.status).send({ error: err.error });
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
      const parsedBody = parseStrictBody(nameBody, request.body);
      if (!parsedBody.ok) return reply.status(400).send(parsedBody.body);
      const { name } = parsedBody.data;
      if (!name) return reply.status(400).send({ error: 'New name required' });
      const result = await driverFor(srv).setPaneTitle(srv, handle, name);
      const err = execResultError(result);
      if (err) return reply.status(err.status).send({ error: err.error });
      return { ok: true };
    },
  );

  // ── DELETE /api/windows/:id/panes/:ordinal ──
  fastify.delete<{ Params: { id: string; ordinal: string }; Querystring: { handle?: string } }>(
    '/api/windows/:id/panes/:ordinal',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const ordinal = parseInt(request.params.ordinal, 10) as PaneOrdinal;
      const { window: win, ref } = resolveWindowById(windowRepo, id);
      const srv = serverRepo.findByName(win.serverName);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      await closePaneInWindow(driverFor(srv), srv, ref, { ordinal, handle: request.query.handle });
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
