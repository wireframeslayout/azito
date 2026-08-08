// ─── Fastify instance assembly ───
//
// Registers plugins, HTTP routes, WebSocket handlers, static files, and the
// event-bridge wiring on an already-created Fastify instance. Mirrors the
// former inline registration block in main.ts.

import type { FastifyInstance } from 'fastify';
import { getPushMessage } from '../modules/notifications/push/pushCatalog';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { WebSocket } from 'ws';

import { resolveRoot } from '../shared/releaseInfo';
import type { Wiring } from './wiring';

import serversRoutes from '../modules/servers/routes';
import projectsRoutes from '../modules/projects/routes';
import unitsRoutes from '../modules/units/routes';
import operationsRoutes from '../modules/operations/routes';
import tasksRoutes from '../modules/tasks/routes';
import providersRoutes from '../modules/agents/routes';
import phasePromptsRoutes from '../modules/prompt/routes';
import storageRoutes, { fileBrowseRoutes } from '../modules/files/routes';
import notificationRoutes from '../modules/notifications/routes';
import usageRoutes from '../modules/usage/routes';
import webhookRoutes from '../modules/notifications/webhooks';
import agentSignalRoutes from '../modules/tasks/turns/agentSignalRoutes';
import windowsRoutes from '../modules/windows/routes';
import hooksRoutes from '../modules/tmux/routes/hooks';
import sessionsRoutes from '../modules/tmux/routes/sessions';
import resourceGuardRoutes from '../modules/servers/resources/routes';
import gitRoutes from '../modules/git/routes';
import sidekicksRoutes from '../modules/sidekicks/routes';
import supervisorsRoutes from '../modules/supervisors/routes';
import healthRoutes from '../modules/health/routes';
import systemRoutes from '../modules/system/routes';

import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { resolvePrincipal } from '../shared/auth/resolvePrincipal';
import { evaluateRouteAuth, UNMATCHED_ROUTE } from '../shared/auth/routeAuth';
import { resolveUnitId } from '../modules/tasks/execution/TaskExecutionEnv';
import { resolvePhaseSidekick } from '../modules/sidekicks/resolvePhaseSidekick';
import type { Principal } from '../shared/auth/Principal';
import type { RouteAuthRequirement } from '../shared/auth/routeAuth';

import { handleTerminalConnection } from '../modules/tmux/ws/terminalHandler';
import { handleTaskLogStream } from '../modules/tasks/ws/taskLogHandler';
import { handleNotificationStream } from '../modules/notifications/ws/notificationHandler';
import browserRoutes from '../modules/browser/routes';
import devtoolsRoutes, { handleDevtoolsRelay } from '../modules/browser/devtools';
import { handleBrowserConnection } from '../modules/browser/ws/browserHandler';
import { proxyBrowserToAgent } from '../modules/servers/transport/AgentBrowserProxy';
import { handleSupervisorConnection } from '../modules/supervisors/ws/supervisorSocketHandler';
import { RenderSkillPromptUseCase } from '../modules/prompt/RenderSkillPromptUseCase';
import { TaskPromptVarsResolver } from '../modules/prompt/TaskPromptVarsResolver';
import { TmuxHookManager } from '../modules/tmux/TmuxHookManager';
import { AgentEventStream } from '../modules/servers/transport/AgentEventStream';
import { notifyAgentWatchesOnIdle } from '../modules/notifications/agentWatchBridge';
import { bridgeSupervisorActivityToProgress } from '../modules/tasks/turns/SupervisorProgressBridge';

export interface ServerHandles {
  tmuxHookManager: TmuxHookManager;
  agentEventStreams: AgentEventStream[];
}

export async function buildServer(app: FastifyInstance, wiring: Wiring, port: number): Promise<ServerHandles> {
  const {
    serverRepo, windowRepo, projectRepo, projectServerRepo, unitRepo, taskRepo, taskTokenRepo, logRepo,
    projectSecretRepo, storageSettingsRepo, pushSubRepo, agentWatchRepo, resourceGuardSettingsRepo, resourceGuard,
    tmuxClient, transportFactory, worktreeServiceFactory, gitProvider, storageClient,
    agentInstaller, agentBundler, harnessInstaller, tmuxInstaller,
    executeTaskUseCase, agentActivityMonitor, windowRespawnService, taskRestoreService, sessionStrategyFactory, sessionCaptureService, usageService,
    pushService, vapidKeys, notificationBus, sidekickPackageService, sidekickPackageLoader,
    sidekickSyncService, unitTypeLoader, agentSignalService, supervisorRegistry, agentTurnRepo, turnSignalHub,
    browserSessionManager, deployModeDetector, systemUpdateService, channelResolver, auditLogService,
    originationService, scopedAuthEnabled, taskPaneEnvironmentService,
  } = wiring;

  // ─── Webhook token ───

  const webhookToken = process.env.AZITO_WEBHOOK_TOKEN || crypto.randomBytes(32).toString('hex');
  const verifyWebhookToken = createTokenVerifier(webhookToken);
  if (!process.env.AZITO_WEBHOOK_TOKEN) {
    console.log(`[webhook] Auto-generated token: ${webhookToken}`);
    console.log('[webhook] Set AZITO_WEBHOOK_TOKEN env to use a fixed token');
  }

  // ─── UI token (resolved by main.ts, passed through wiring) ───

  const verifyUiToken = createTokenVerifier(wiring.uiToken);

  const harnessPrefix = process.env.AZITO_HARNESS_PREFIX || undefined;

  // ─── Push notifications on task status changes ───

  const STATUS_TO_PUSH_KEY: Record<string, import('../modules/notifications/push/pushCatalog').PushMessageKey> = {
    done:              'task.done',
    error:             'task.error',
    stopped_by_user:   'task.stoppedByUser',
    send_error:        'task.sendError',
    codex_error:       'task.codexError',
    waiting_for_human: 'task.waitingForHuman',
    phase_review:      'task.phaseReview',
    pending_approval:  'task.pendingApproval',
  };

  executeTaskUseCase.events.on('log', (entry: { taskId: number; type: string; content: { status?: string } }) => {
    if (entry.type !== 'status_change' || !entry.content.status) return;
    const pushKey = STATUS_TO_PUSH_KEY[entry.content.status];
    if (!pushKey) return;
    const task = taskRepo.findById(entry.taskId);
    if (!task) return;
    const subs = pushSubRepo.findAll();
    pushService.sendToAll(subs, (sub) => ({
      ...getPushMessage(sub.lang, pushKey, { taskTitle: task.title }),
      data: { url: `/workspace/${task.projectId}`, taskId: task.id },
    })).catch(() => {});
  });

  // ─── Idle-watch push notifications (agent:activity → push, one-shot) ───
  // A user can register a one-shot "notify me when this pane goes idle" watch
  // via POST /api/agent-watches. When AgentActivityMonitor later emits
  // `agent:activity` with running:false for that server/target, send a push
  // and consume the watch (see agentWatchBridge.ts for the delete-on-failure
  // rationale).
  notificationBus.on((event) => {
    if (event.type !== 'agent:activity') return;
    notifyAgentWatchesOnIdle(event.payload, { agentWatchRepo, pushSubRepo, pushService }).catch(() => {});
  });

  // ─── Agent completed/blocked push notifications (replaces the old hook-based
  // agent-done webhook push — see webhooks.ts) ───
  // Sends a push to every subscriber (not just one-shot watches) when an
  // agent transitions to idle (completed) or to a blocked (approval-required)
  // state, so users get notified without having to register a watch first.
  notificationBus.on((event) => {
    if (event.type !== 'agent:activity') return;
    const { serverName, target, label, taskId, running, status } = event.payload;

    if (running === false) {
      const subs = pushSubRepo.findAll();
      pushService.sendToAll(subs, (sub) => ({
        ...getPushMessage(sub.lang, 'agent.finished', { label: label || target, serverName }),
        data: { url: '/workspace', serverName, target },
      })).catch(() => {});
      return;
    }

    if (running === true && status === 'blocked') {
      const subs = pushSubRepo.findAll();
      pushService.sendToAll(subs, (sub) => ({
        ...getPushMessage(sub.lang, 'agent.approvalRequired', { label: label || target, serverName }),
        data: { url: '/workspace', serverName, target, taskId },
      })).catch(() => {});
    }
  });

  // ─── Supervisor activity bridges (AZITO監視強化 Phase 3b Step 6) ───
  // `tui-supervisor` connections report activity/exit via SupervisorRegistry.
  // Two independent consumers subscribe to the same events:
  // (A) progress bridge — refreshes WorkerWaiter's idle timer for the task's
  //     running turn while the supervised child is actively producing output.
  // (B) AgentActivityMonitor Tier 0 — the highest-priority activity source,
  //     bypassing the hook (Tier 1) and polling heuristic (Tier 2) entirely
  //     for keys with a live supervisor connection.
  // (C) ready bridge — forwards the child TUI's boot-complete signal to the
  //     frontend as a `supervisor:ready` notification (events WS).
  supervisorRegistry.on('activity', (event) => {
    bridgeSupervisorActivityToProgress(event, { agentTurnRepo, turnSignalHub });
    // Label a "pure supervised" entry (no windows-table row) from the child
    // command's first token (e.g. "claude --dangerously-skip-permissions" →
    // "claude") — AgentActivityMonitor deliberately does not import
    // SupervisorRegistry, so this derivation lives here at the wiring point.
    const label = event.childCommand.trim().split(/\s+/)[0] || null;
    agentActivityMonitor.recordSupervisorSignal(event.serverName, event.target, event.state, event.taskId, label, event.status);
  });
  supervisorRegistry.on('child_exit', (event) => {
    agentActivityMonitor.recordSupervisorSignal(event.serverName, event.target, 'exited');
  });
  supervisorRegistry.on('disconnected', (event) => {
    agentActivityMonitor.recordSupervisorSignal(event.serverName, event.target, 'exited');
  });
  supervisorRegistry.on('ready', (event) => {
    notificationBus.emit({
      type: 'supervisor:ready',
      payload: { serverName: event.serverName, target: event.target, ...(event.taskId != null ? { taskId: event.taskId } : {}) },
    });
  });

  // ─── Plugins ───

  const allowedOrigins = (process.env.AZITO_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3001')
    .split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, { origin: allowedOrigins, credentials: false });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 52_428_800 } });
  // Responses are served over Tailscale, often from mobile networks where the
  // task list's size dominates every other cost. `threshold` keeps the small,
  // frequent responses (health, sessions) from paying compression overhead.
  await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate'] });

  // ─── Authorization (Issue #28 Phase A) ───
  //
  // AZITO_SCOPED_AUTH gates whether a route auth declaration's rejection is
  // actually enforced (403) or only audit-logged as "would have been
  // denied" (design v3 §12 staged migration: A~E all merge behind this
  // flag, then it flips on once every stage is deployed). Default off keeps
  // every existing behavior byte-for-byte identical except that task panes
  // now always carry an AZITO_TASK_TOKEN (see TaskPaneEnvironmentService) —
  // a credential nothing recognized before Phase A, so its presence changes
  // nothing observable until AZITO_SCOPED_AUTH=1.
  //
  // Resolved ONCE in app/wiring.ts (shared/auth/scopedAuthFlag.ts) — not
  // read from process.env here — so this file and
  // TaskPaneEnvironmentService (constructed earlier, in wiring.ts) can never
  // disagree about which mode the hub is running in.

  // ── GET /api/sidekicks(/:name) task-principal auth ──
  // Cross-module (task -> project -> unit -> phaseConfig -> Sidekick tags)
  // lookup, so it lives here rather than in modules/sidekicks/routes.ts —
  // sidekicks is a mid-layer module and must not depend on tasks/units
  // (see .dependency-cruiser.cjs's mid-sidekicks-limited rule).
  //
  // Single source of truth for "which Sidekicks is this task's Unit allowed
  // to see" — both the detail route's condition (single-name check) and the
  // list route's response filter (Issue #28 third-party review fix 1+2:
  // GET /api/sidekicks previously had no task-principal auth at all, and
  // GET /api/sidekicks/:name required an explicit task_id even though the
  // task pane's own AZITO_TASK_ID env var already identifies it) derive from
  // this one resolver, never reimplementing the phase-walk themselves.
  function resolveAssignedSidekickNamesForTask(taskId: number): Set<string> {
    const task = taskRepo.findById(taskId);
    if (!task) return new Set();
    const project = projectRepo.findById(task.projectId);
    const resolvedUnitId = resolveUnitId(task, project);
    if (resolvedUnitId === null) return new Set();
    const unit = unitRepo.findById(resolvedUnitId);
    if (!unit) return new Set();
    const unitType = unitTypeLoader.getOrThrow(unit.unitType);
    const names = new Set<string>();
    for (const phaseDef of unitType.phases) {
      try {
        const pkg = resolvePhaseSidekick(sidekickPackageLoader, phaseDef.name, unit.phaseConfig, phaseDef);
        names.add(pkg.name);
      } catch {
        // Phase misconfigured (e.g. assigned package no longer exists) — not
        // a grant for this task, fall through to the next phase.
      }
    }
    return names;
  }

  const sidekickDetailAuth: RouteAuthRequirement = {
    classes: ['task'],
    operation: 'sidekicks.render',
    condition: (principal, request) => {
      const query = request.query as { render?: string; task_id?: string };
      if (query.render !== '1' || !query.task_id) return false;
      const taskId = Number(query.task_id);
      if (!Number.isInteger(taskId) || principal.id !== taskId) return false;
      const name = (request.params as { name: string }).name;
      return resolveAssignedSidekickNamesForTask(taskId).has(name);
    },
  };

  // GET /api/sidekicks (list): a task principal is always allowed to reach
  // the route — the response itself is narrowed to that task's Unit's
  // assigned Sidekicks in modules/sidekicks/routes.ts via
  // `resolveAssignedSidekickNames`, so there's no per-name relationship to
  // check at the auth-gate level (unlike the detail route, which grants or
  // denies a single named Sidekick).
  const sidekickListAuth: RouteAuthRequirement = {
    classes: ['task'],
    operation: 'sidekicks.list',
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;
    if (request.url.startsWith('/api/health')) return;
    if (request.url.startsWith('/api/webhooks/')) return;
    if (request.url.startsWith('/api/hooks/')) return;
    if (request.url.startsWith('/api/agent-signal')) return;

    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    request.principal = principal;

    const { allowed, operation } = evaluateRouteAuth(principal, request);
    if (!allowed) {
      // Audit persistence is best-effort: a write failure (disk full, locked
      // DB, etc.) must never overturn the authorization decision already
      // computed above. Without this catch, a throwing record() would
      // propagate out of this hook and Fastify would answer with a generic
      // 500 instead of the 403 (enforcement) / pass-through (compat) the
      // evaluation actually produced — silently upgrading a would-be-denied
      // request's visible failure mode (Issue #28 third-party review finding).
      try {
        auditLogService.record({
          actorClass: principal.class,
          actorId: principal.id ?? null,
          event: scopedAuthEnabled ? 'route_auth.denied' : 'route_auth.would_deny',
          // The normalized ROUTE path (e.g. '/api/tasks/:id'), never
          // request.url — that includes the raw query string, which can carry
          // arbitrary caller-supplied values (search terms, tokens pasted into
          // a query param by mistake, etc.) into audit_log (Issue #28
          // third-party review finding 3). An UNMATCHED route (no route at all
          // — routeOptions.url is undefined) falls back to the fixed
          // UNMATCHED_ROUTE placeholder, never request.url: the raw URL here
          // is fully caller-controlled (an unmatched path always 403s before
          // this point) and varying its query string on every probe would
          // otherwise defeat AuditLogService's flood dedup, which keys on the
          // full JSON-serialized `detail` (Issue #28 third-party review
          // finding 2 — a later round on the same file).
          detail: { operation, method: request.method, url: request.routeOptions.url ?? UNMATCHED_ROUTE },
        });
      } catch (err) {
        request.log.error({ err, operation }, 'route_auth audit log write failed; continuing with computed decision');
      }
      if (scopedAuthEnabled) {
        return reply.status(403).send({ error: 'operator_required', operation });
      }
    }
  });

  // ─── HTTP routes ───

  await app.register(serversRoutes, { serverRepo, tmux: tmuxClient, transportFactory, agentInstaller, agentBundler, harnessInstaller, tmuxInstaller, projectRepo, projectServerRepo, webhookToken, uiToken: wiring.uiToken, harnessPrefix });
  await app.register(sessionsRoutes, {
    serverRepo, tmux: tmuxClient, windowRepo, notificationBus, resourceGuard,
    onTaskWindowDestroyed: (taskId, reason) => taskPaneEnvironmentService.revokeForDestroyedWindow(taskId, reason),
  });
  await app.register(fileBrowseRoutes, { serverRepo, tmux: tmuxClient });
  await app.register(gitRoutes, { serverRepo, transportFactory });
  await app.register(projectsRoutes, { projectRepo, projectServerRepo, taskRepo, gitProvider, tmux: tmuxClient, serverRepo, projectSecretRepo, originationService });
  await app.register(unitsRoutes, { unitRepo, taskRepo, logRepo, executeTaskUseCase, projectRepo, projectServerRepo, serverRepo, sidekickLoader: sidekickPackageLoader, unitTypeLoader });
  await app.register(operationsRoutes, { executeTaskUseCase, agentActivityMonitor });
  await app.register(tasksRoutes, { taskRepo, auditLogService, projectRepo, projectServerRepo, logRepo, executeTaskUseCase, unitRepo, tmux: tmuxClient, serverRepo, worktreeServiceFactory, transportFactory, windowRepo, respawnService: windowRespawnService, taskRestoreService, unitTypeLoader, sidekickLoader: sidekickPackageLoader, projectSecretRepo, originationService, taskTokenRepo });
  await app.register(windowsRoutes, { windowRepo, projectRepo, taskRepo, tmux: tmuxClient, serverRepo, respawnService: windowRespawnService, sessionStrategyFactory, sessionCaptureService, supervisorRegistry, notificationBus, resourceGuard });
  await app.register(providersRoutes, { providerRepo: wiring.providerRepo });
  const renderSkillPromptUseCase = new RenderSkillPromptUseCase(
    taskRepo,
    projectRepo,
    unitRepo,
    projectServerRepo,
    sidekickPackageLoader,
    serverRepo,
    transportFactory,
    sidekickSyncService,
    unitTypeLoader,
  );

  await app.register(phasePromptsRoutes, { sidekickLoader: sidekickPackageLoader, renderSkillPromptUseCase, unitTypeLoader });
  await app.register(storageRoutes, { projectRepo, storageSettingsRepo, storageClient });
  await app.register(resourceGuardRoutes, { settingsRepo: resourceGuardSettingsRepo, resourceGuard, serverRepo, transportFactory });
  await app.register(notificationRoutes, { pushSubRepo, pushService, vapidKeys, agentWatchRepo });
  await app.register(usageRoutes, { usageService });
  await app.register(webhookRoutes, {
    taskRepo,
    verifyToken: verifyWebhookToken,
    recordAgentActivity: (signal) => agentActivityMonitor.recordHookSignal(signal),
  });
  await app.register(agentSignalRoutes, { agentSignalService, verifyToken: verifyWebhookToken });
  await app.register(hooksRoutes, { notificationBus, verifyToken: verifyWebhookToken });
  const taskPromptVarsResolver = new TaskPromptVarsResolver(
    taskRepo,
    projectRepo,
    unitRepo,
    projectServerRepo,
    serverRepo,
    transportFactory,
    sidekickPackageLoader,
    sidekickSyncService,
  );
  await app.register(sidekicksRoutes, {
    sidekickService: sidekickPackageService,
    taskPromptVarsResolver,
    unitTypeLoader,
    detailAuth: sidekickDetailAuth,
    listAuth: sidekickListAuth,
    resolveAssignedSidekickNames: resolveAssignedSidekickNamesForTask,
  });
  await app.register(supervisorsRoutes, { supervisorRegistry });
  await app.register(healthRoutes, { deployModeDetector });
  await app.register(systemRoutes, { systemUpdateService, channelResolver });
  await app.register(browserRoutes, {
    browserSessionManager,
    serverRepo,
    onTabOpened: (payload) => {
      notificationBus.emit({ type: 'browser:opened', payload });
    },
  });
  await app.register(devtoolsRoutes, { serverRepo, browserSessionManager });

  // ─── WebSocket ───

  await app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        socket.close(1008, 'Forbidden origin');
        return;
      }
      const wsUrl = new URL(request.url, 'http://localhost');
      const wsToken = wsUrl.searchParams.get('token');
      if (!verifyUiToken(wsToken ? `Bearer ${wsToken}` : undefined)) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      const serverName = wsUrl.searchParams.get('server');
      const target = wsUrl.searchParams.get('target');
      const mode = wsUrl.searchParams.get('mode');
      const cols = parseInt(wsUrl.searchParams.get('cols') || '120', 10);
      const rows = parseInt(wsUrl.searchParams.get('rows') || '40', 10);

      if (mode === 'events') {
        handleNotificationStream(socket, notificationBus);
        return;
      }

      if (mode === 'task-logs') {
        const taskId = parseInt(wsUrl.searchParams.get('taskId') || '0', 10);
        if (taskId) {
          handleTaskLogStream(socket, taskId, executeTaskUseCase, logRepo);
          return;
        }
      }

      if (mode === 'browser') {
        if (!serverName) {
          socket.send(JSON.stringify({ error: 'server parameter required' }));
          socket.close();
          return;
        }
        const srv = serverRepo.findByName(serverName);
        if (!srv) {
          socket.send(JSON.stringify({ error: 'Server not found' }));
          socket.close();
          return;
        }
        const rawGroupId = wsUrl.searchParams.get('group');
        const groupId = rawGroupId && /^[A-Za-z0-9_-]{1,64}$/.test(rawGroupId) ? rawGroupId : 'default';
        const rawTabId = wsUrl.searchParams.get('page');
        const tabId = rawTabId && /^[A-Za-z0-9_-]{1,64}$/.test(rawTabId) ? rawTabId : 't1';
        if (srv.type === 'agent') {
          proxyBrowserToAgent(socket, srv, 'browser', `page=${encodeURIComponent(tabId)}&group=${encodeURIComponent(groupId)}`);
          return;
        }
        const hubOrigin = `http://localhost:${port}`;
        handleBrowserConnection(socket, browserSessionManager, serverName, groupId, tabId, hubOrigin);
        return;
      }

      if (mode === 'devtools') {
        if (!target) {
          socket.send(JSON.stringify({ error: 'target parameter required' }));
          socket.close();
          return;
        }
        if (serverName) {
          const srv = serverRepo.findByName(serverName);
          if (srv?.type === 'agent') {
            proxyBrowserToAgent(socket, srv, 'devtools', `target=${encodeURIComponent(target)}`);
            return;
          }
        }
        handleDevtoolsRelay(socket, target);
        return;
      }

      const srv = serverName ? serverRepo.findByName(serverName) : null;
      if (!srv || !target) {
        socket.send(JSON.stringify({ error: 'Invalid server or target' }));
        socket.close();
        return;
      }

      handleTerminalConnection(socket, srv, target, cols, rows, transportFactory);
    });
  });

  // ─── Supervisor WebSocket (tui-supervisor outbound connections) ───

  await app.register(async (fastify) => {
    fastify.get('/ws/supervisor', { websocket: true }, (socket: WebSocket, request) => {
      if (!verifyWebhookToken(request.headers.authorization)) {
        socket.close(1008, 'Unauthorized');
        return;
      }
      handleSupervisorConnection(socket, supervisorRegistry);
    });
  });

  // ─── Static files (production build) ───

  const publicDir = path.join(resolveRoot(), 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const accepts = request.headers.accept ?? '';
      if (
        request.method !== 'GET' ||
        request.url.startsWith('/api') ||
        request.url.startsWith('/ws') ||
        request.url.startsWith('/devtools-fe') ||
        !accepts.includes('text/html')
      ) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  // ─── Task status → NotificationBus bridge ───

  executeTaskUseCase.events.on('log', (entry: { taskId: number; type: string; content: { status?: string } }) => {
    if (entry.type !== 'status_change' || !entry.content.status) return;
    const task = taskRepo.findById(entry.taskId);
    notificationBus.emit({
      type: 'task:status',
      payload: { taskId: entry.taskId, status: entry.content.status, title: task?.title, projectId: task?.projectId },
    });
  });

  // ─── Phase completion → NotificationBus bridge ───
  // PhaseLoopRunner がフェーズ完了時に出す phase_completed ログをライフサイクル
  // イベントとして中継する。購読側（push 通知・将来のフェーズ完了フック等）は
  // NotificationBus 側にぶら下げる。
  executeTaskUseCase.events.on('log', (entry: {
    taskId: number;
    unitId: number;
    type: string;
    content: { type?: string; phase?: string; summary?: Record<string, unknown> | null };
  }) => {
    if (entry.type !== 'command' || entry.content.type !== 'phase_completed' || !entry.content.phase) return;
    notificationBus.emit({
      type: 'phase:completed',
      payload: {
        taskId: entry.taskId,
        unitId: entry.unitId,
        phase: entry.content.phase,
        summary: entry.content.summary ?? null,
      },
    });
  });

  // ─── Shutdown cleanup (must register before listen) ───

  const tmuxHookManager = new TmuxHookManager(transportFactory, port, webhookToken);
  const agentEventStreams: AgentEventStream[] = [];

  agentActivityMonitor.start();

  app.addHook('onClose', async () => {
    // stopAll() first: playwright's own SIGTERM/SIGINT/SIGHUP handlers are disabled
    // (see BrowserSession.ts), so a Chromium session must be closed here before the
    // 8s hard cap in main.ts's graceful shutdown can starve it in favor of later steps.
    await browserSessionManager.stopAll();
    agentActivityMonitor.stop();
    const localServers = serverRepo.findAll().filter((s) => s.type === 'local');
    await tmuxHookManager.uninstallAll(localServers);
    for (const stream of agentEventStreams) stream.stop();
    notificationBus.destroy();
  });

  return { tmuxHookManager, agentEventStreams };
}
