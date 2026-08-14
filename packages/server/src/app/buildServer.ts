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
import { FileSearchService } from '../modules/files/FileSearchService';
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
import chatCommandsRoutes from '../modules/chat-commands/routes';
import supervisorsRoutes from '../modules/supervisors/routes';
import healthRoutes from '../modules/health/routes';
import systemRoutes from '../modules/system/routes';
import transcriptsRoutes from '../modules/transcripts/routes';
import { TRANSCRIPT_SOURCES, claudeTranscriptSource } from '../modules/transcripts/sources/registry';
import { TranscriptPaneService } from '../modules/transcripts/TranscriptPaneService';
import { WindowInputService } from '../modules/transcripts/WindowInputService';

import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';

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
    serverRepo, windowRepo, projectRepo, projectServerRepo, unitRepo, taskRepo, logRepo,
    projectSecretRepo, storageSettingsRepo, pushSubRepo, agentWatchRepo, resourceGuardSettingsRepo, resourceGuard,
    tmuxClient, transportFactory, worktreeServiceFactory, gitProvider, storageClient,
    agentInstaller, agentBundler, harnessInstaller, tmuxInstaller,
    executeTaskUseCase, agentActivityMonitor, interactionMonitor, windowRespawnService, taskRestoreService, sessionStrategyFactory, sessionCaptureService, usageService,
    windowSessionResolver, windowActivityStatusService,
    pushService, vapidKeys, notificationBus, sidekickPackageService, sidekickPackageLoader,
    sidekickSyncService, unitTypeLoader, chatCommandLoader, agentSignalService, supervisorRegistry, agentTurnRepo, turnSignalHub,
    browserSessionManager, deployModeDetector, systemUpdateService, channelResolver,
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
    // A 'deleted' transition means the window itself is gone (it may not even
    // have been running); that is window bookkeeping, not "the pane went idle",
    // so it must not consume a watch. Every other stop reason still does.
    if (event.payload.reason === 'deleted') return;
    notifyAgentWatchesOnIdle(event.payload, { agentWatchRepo, pushSubRepo, pushService }).catch(() => {});
  });

  // ─── Agent completed/blocked push notifications (replaces the old hook-based
  // agent-done webhook push — see webhooks.ts) ───
  // Sends a push to every subscriber (not just one-shot watches) when an
  // agent transitions to idle (completed) or to a blocked (approval-required)
  // state, so users get notified without having to register a watch first.
  //
  // Only `reason: 'completed'` counts as "finished" (P3): a stop caused by a
  // user interrupt, a deleted window, a vanished process or an unattributable
  // heuristic timeout is not a completion, and pushing "agent finished" for
  // those is exactly the false-completion class this reason field exists to end.
  notificationBus.on((event) => {
    if (event.type !== 'agent:activity') return;
    const { serverName, target, label, taskId, running, status, reason } = event.payload;

    if (running === false && reason === 'completed') {
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

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;
    if (request.url.startsWith('/api/health')) return;
    if (request.url.startsWith('/api/webhooks/')) return;
    if (request.url.startsWith('/api/hooks/')) return;
    if (request.url.startsWith('/api/agent-signal')) return;

    if (!verifyUiToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // ─── HTTP routes ───

  await app.register(serversRoutes, { serverRepo, tmux: tmuxClient, transportFactory, agentInstaller, agentBundler, harnessInstaller, tmuxInstaller, projectRepo, projectServerRepo, webhookToken, uiToken: wiring.uiToken, harnessPrefix });
  await app.register(sessionsRoutes, { serverRepo, tmux: tmuxClient, windowRepo, notificationBus, resourceGuard });
  const fileSearchService = new FileSearchService(transportFactory);
  await app.register(fileBrowseRoutes, { serverRepo, tmux: tmuxClient, projectServerRepo, transportFactory, searchService: fileSearchService });
  await app.register(gitRoutes, { serverRepo, transportFactory, taskRepo, projectServerRepo, worktreeServiceFactory });
  await app.register(projectsRoutes, { projectRepo, projectServerRepo, taskRepo, gitProvider, tmux: tmuxClient, serverRepo, projectSecretRepo });
  await app.register(unitsRoutes, { unitRepo, taskRepo, logRepo, executeTaskUseCase, projectRepo, projectServerRepo, serverRepo, sidekickLoader: sidekickPackageLoader, unitTypeLoader });
  await app.register(operationsRoutes, { executeTaskUseCase, agentActivityMonitor, supervisorRegistry, windowRepo });
  await app.register(tasksRoutes, { taskRepo, projectRepo, projectServerRepo, logRepo, executeTaskUseCase, unitRepo, tmux: tmuxClient, serverRepo, worktreeServiceFactory, transportFactory, windowRepo, respawnService: windowRespawnService, taskRestoreService, unitTypeLoader, sidekickLoader: sidekickPackageLoader, projectSecretRepo });
  await app.register(windowsRoutes, { windowRepo, projectRepo, taskRepo, tmux: tmuxClient, serverRepo, respawnService: windowRespawnService, sessionStrategyFactory, sessionCaptureService, supervisorRegistry, windowActivityStatusService, notificationBus, resourceGuard });
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
    recordInteractionSignal: (signal) => interactionMonitor.recordSignal(signal),
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
  await app.register(sidekicksRoutes, { sidekickService: sidekickPackageService, taskPromptVarsResolver, unitTypeLoader });
  await app.register(chatCommandsRoutes, { chatCommandLoader });
  await app.register(supervisorsRoutes, { supervisorRegistry });
  await app.register(healthRoutes, { deployModeDetector });
  await app.register(transcriptsRoutes, {
    sources: TRANSCRIPT_SOURCES,
    transcriptPaneService: new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo),
    windowSessionResolver,
    windowInputService: new WindowInputService(windowRepo, tmuxClient, serverRepo),
    windowRepo,
    interactionMonitor,
  });
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
