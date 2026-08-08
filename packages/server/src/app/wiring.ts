// ─── Dependency wiring ───
//
// Constructs all infrastructure/repository/domain/application instances via
// manual `new` (no DI container). Mirrors the former inline construction in
// main.ts; grouped into per-module factory functions for readability.

import { EventEmitter } from 'events';
import type { SqliteDatabase } from '../shared/db/Database';
import type { DataPaths } from '../shared/dataDir';

import { SshClient, type FingerprintStore } from '../modules/servers/ssh/SshClient';
import { TransportFactory } from '../modules/servers/transport/TransportFactory';
import { TmuxClient } from '../modules/tmux/TmuxClient';
import { CodexExecClient } from '../modules/llm/CodexExecClient';
import type { ILlmClient } from '../modules/llm/ILlmClient';
import { PaneClassifier } from '../modules/llm/PaneClassifier';
import { LlmContentExtractor } from '../modules/llm/LlmContentExtractor';
import type { IContentExtractor } from '../modules/llm/ContentExtractor';
import { PaneStreamFactory } from '../modules/tmux/PaneStreamFactory';
import { GitProviderService } from '../modules/git/providers/GitProviderService';
import { WorktreeServiceFactory } from '../modules/git/WorktreeServiceFactory';
import { MinioStorageClient } from '../modules/files/storage/MinioStorageClient';
import { getVapidKeys, type VapidKeys } from '../modules/notifications/push/VapidKeyManager';
import { PushNotificationService } from '../modules/notifications/push/PushNotificationService';
import { AgentBundler } from '../modules/servers/agent-deploy/AgentBundler';
import { AgentInstaller } from '../modules/servers/agent-deploy/AgentInstaller';
import { AgentUpdater } from '../modules/servers/agent-deploy/AgentUpdater';
import { HarnessInstaller } from '../modules/servers/agent-deploy/HarnessInstaller';
import { TmuxInstaller } from '../modules/servers/agent-deploy/TmuxInstaller';
import { NotificationBus } from '../modules/notifications/NotificationBus';

import { SqliteServerRepository } from '../modules/servers/SqliteServerRepository';
import { SqliteProjectRepository } from '../modules/projects/SqliteProjectRepository';
import { SqliteProviderRepository } from '../modules/llm/SqliteProviderRepository';
import { SqliteUnitRepository } from '../modules/units/SqliteUnitRepository';
import { SqliteTaskRepository } from '../modules/tasks/SqliteTaskRepository';
import { SqliteTaskTokenRepository } from '../modules/tasks/tokens/SqliteTaskTokenRepository';
import { SqliteExecutionLogRepository } from '../modules/tasks/SqliteExecutionLogRepository';
import { SqliteProjectServerRepository } from '../modules/projects/SqliteProjectServerRepository';
import { SqliteProjectSecretRepository } from '../modules/projects/SqliteProjectSecretRepository';
import { SqliteStorageSettingsRepository } from '../modules/files/SqliteStorageSettingsRepository';
import { SqlitePushSubscriptionRepository } from '../modules/notifications/SqlitePushSubscriptionRepository';
import { SqliteAgentWatchRepository } from '../modules/notifications/SqliteAgentWatchRepository';
import { SqliteWindowRepository } from '../modules/windows/SqliteWindowRepository';
import { SqliteAgentTurnRepository } from '../modules/tasks/turns/SqliteAgentTurnRepository';
import { SqliteResourceGuardSettingsRepository } from '../modules/servers/resources/SqliteResourceGuardSettingsRepository';
import { SqliteAuditLogRepository } from '../shared/audit/AuditLogRepository';
import { AuditLogService } from '../shared/audit/AuditLogService';
import { resolveScopedAuthEnabled } from '../shared/auth/scopedAuthFlag';
import { TaskOriginationService } from '../modules/tasks/origination/TaskOriginationService';
import { TaskPaneEnvironmentService } from '../modules/tasks/execution/TaskPaneEnvironmentService';
import { ResourceGuard } from '../modules/servers/resources/ResourceGuard';
import { TurnSignalHub } from '../modules/tasks/turns/TurnSignalHub';
import { AgentSignalService } from '../modules/tasks/turns/AgentSignalService';
import { SidekickPackageLoader } from '../modules/sidekicks/SidekickPackageLoader';
import { SidekickPackageService } from '../modules/sidekicks/SidekickPackageService';
import { SidekickSyncService } from '../modules/sidekicks/SidekickSyncService';
import { UnitTypeLoader } from '../modules/sidekicks/UnitTypeLoader';
import { SupervisorRegistry } from '../modules/supervisors/SupervisorRegistry';
import { SqliteSupervisorLaunchRepository } from '../modules/supervisors/SupervisorLaunchRepository';
import { BrowserSessionManager } from '../modules/browser/BrowserSessionManager';
import { SqliteBrowserSnapshotRepository } from '../modules/browser/SqliteBrowserSnapshotRepository';

import { AgentRegistry, createDefaultRegistry } from '../modules/agents/registry';

import { ExecuteTaskUseCase } from '../modules/tasks/execution/ExecuteTaskUseCase';
import { AgentActivityMonitor } from '../modules/operations/AgentActivityMonitor';
import { WindowRespawnService } from '../modules/windows/WindowRespawnService';
import { SessionCaptureService } from '../modules/windows/SessionCaptureService';
import { stripPaneSuffix } from '../modules/windows/paneTarget';
import { TaskRestoreService } from '../modules/tasks/TaskRestoreService';
import { SessionStrategyFactory } from '../modules/agents/SessionStrategyFactory';
import { UsageService } from '../modules/usage/UsageService';
import { UpdateChannelResolver } from '../modules/system/UpdateChannelResolver';
import { UpdateStateManager } from '../modules/system/UpdateStateManager';
import { DeployModeDetector } from '../modules/system/DeployModeDetector';
import { SystemUpdateService } from '../modules/system/SystemUpdateService';

// ─── Module return types ───

export interface SharedInfra {
  sshClient: SshClient;
  agentInstaller: AgentInstaller;
  harnessInstaller: HarnessInstaller;
  tmuxInstaller: TmuxInstaller;
  transportFactory: TransportFactory;
  tmuxClient: TmuxClient;
  llmClient: ILlmClient;
  agentRegistry: AgentRegistry;
  paneClassifier: PaneClassifier;
  contentExtractor: IContentExtractor;
  paneStreamFactory: PaneStreamFactory;
  gitProvider: GitProviderService;
  worktreeServiceFactory: WorktreeServiceFactory;
  storageClient: MinioStorageClient;
  notificationBus: NotificationBus;
  sidekickPackageLoader: SidekickPackageLoader;
  sidekickPackageService: SidekickPackageService;
  sidekickSyncService: SidekickSyncService;
  unitTypeLoader: UnitTypeLoader;
  turnSignalHub: TurnSignalHub;
  supervisorRegistry: SupervisorRegistry;
  browserSessionManager: BrowserSessionManager;
}

export interface Repositories {
  serverRepo: SqliteServerRepository;
  windowRepo: SqliteWindowRepository;
  projectRepo: SqliteProjectRepository;
  providerRepo: SqliteProviderRepository;
  unitRepo: SqliteUnitRepository;
  taskRepo: SqliteTaskRepository;
  taskTokenRepo: SqliteTaskTokenRepository;
  logRepo: SqliteExecutionLogRepository;
  projectServerRepo: SqliteProjectServerRepository;
  projectSecretRepo: SqliteProjectSecretRepository;
  storageSettingsRepo: SqliteStorageSettingsRepository;
  pushSubRepo: SqlitePushSubscriptionRepository;
  agentTurnRepo: SqliteAgentTurnRepository;
  agentWatchRepo: SqliteAgentWatchRepository;
  resourceGuardSettingsRepo: SqliteResourceGuardSettingsRepository;
  auditLogRepo: SqliteAuditLogRepository;
  auditLogService: AuditLogService;
}

export interface PushNotificationModule {
  vapidKeys: VapidKeys;
  pushService: PushNotificationService;
}

export interface ApplicationServices {
  sessionStrategyFactory: SessionStrategyFactory;
  sessionCaptureService: SessionCaptureService;
  windowRespawnService: WindowRespawnService;
  taskRestoreService: TaskRestoreService;
  usageService: UsageService;
  agentSignalService: AgentSignalService;
  // Shared task-events EventEmitter (Issue #328 fifteenth-round review) —
  // constructed once here (before ExecuteTaskUseCase, which WindowRespawnService/
  // TaskRestoreService are themselves built ahead of) and injected into all
  // three, so every execution-gate call site emits on the SAME instance
  // buildServer.ts's NotificationBus/push bridges subscribe to via
  // `executeTaskUseCase.events.on('log', ...)`. See AppendLog.ts's
  // appendLogAndEmit() doc comment for why a per-class private EventEmitter
  // (the previous shape) silently dropped notifications from every entry
  // point except ExecuteTaskUseCase's own.
  taskEvents: EventEmitter;
  /** Issue #28 Phase A後半: the sole task-creation funnel — see TaskOriginationService's own doc comment. */
  originationService: TaskOriginationService;
  /** Issue #28 Phase A後半: the sole task-pane env builder — see TaskPaneEnvironmentService's own doc comment. */
  taskPaneEnvironmentService: TaskPaneEnvironmentService;
}

export interface SystemUpdateModule {
  deployModeDetector: DeployModeDetector;
  systemUpdateService: SystemUpdateService;
  channelResolver: UpdateChannelResolver;
}

export interface Wiring extends SharedInfra, Repositories, PushNotificationModule, ApplicationServices, SystemUpdateModule {
  uiToken: string;
  agentBundler: AgentBundler;
  agentUpdater: AgentUpdater;
  executeTaskUseCase: ExecuteTaskUseCase;
  agentActivityMonitor: AgentActivityMonitor;
  resourceGuard: ResourceGuard;
  /** Issue #28 Phase A: resolved once here (the composition root boundary) via shared/auth/scopedAuthFlag.ts, then threaded through — see that file's doc comment for why buildServer.ts reads this instead of process.env directly. */
  scopedAuthEnabled: boolean;
}

// ─── Per-module factories ───

function buildSharedInfra(agentBundler: AgentBundler, publicUrl: string, localUrl: string, dataPaths: DataPaths, uiToken: string, db?: SqliteDatabase, fingerprintStore?: FingerprintStore, auditLogService?: AuditLogService, scopedAuthEnabled: boolean = false): SharedInfra {
  const sshClient = new SshClient(fingerprintStore);
  const agentInstaller = new AgentInstaller(sshClient, agentBundler);
  const harnessInstaller = new HarnessInstaller(sshClient);
  const tmuxInstaller = new TmuxInstaller();
  const transportFactory = new TransportFactory(publicUrl);
  const tmuxClient = new TmuxClient(transportFactory, publicUrl, uiToken, localUrl);
  const llmClient: ILlmClient = new CodexExecClient();
  const agentRegistry = createDefaultRegistry();
  const paneClassifier = new PaneClassifier(llmClient);
  const contentExtractor = new LlmContentExtractor(llmClient);
  const paneStreamFactory = new PaneStreamFactory(transportFactory);
  const gitProvider = new GitProviderService();
  const worktreeServiceFactory = new WorktreeServiceFactory();
  const storageClient = new MinioStorageClient();
  const notificationBus = new NotificationBus();
  const sidekickPackageLoader = new SidekickPackageLoader(undefined, dataPaths.sidekicks);
  const sidekickPackageService = new SidekickPackageService(sidekickPackageLoader, dataPaths.sidekicks);
  const sidekickSyncService = new SidekickSyncService();
  const unitTypeLoader = new UnitTypeLoader();
  const turnSignalHub = new TurnSignalHub();
  const supervisorLaunchRepo = db ? new SqliteSupervisorLaunchRepository(db) : undefined;
  const supervisorRegistry = new SupervisorRegistry(supervisorLaunchRepo, auditLogService, scopedAuthEnabled);
  const browserSnapshotRepo = db ? new SqliteBrowserSnapshotRepository(db) : undefined;
  const browserSessionManager = new BrowserSessionManager(
    dataPaths.browserProfile,
    browserSnapshotRepo,
  );

  return {
    sshClient,
    agentInstaller,
    harnessInstaller,
    tmuxInstaller,
    transportFactory,
    tmuxClient,
    llmClient,
    agentRegistry,
    paneClassifier,
    contentExtractor,
    paneStreamFactory,
    gitProvider,
    worktreeServiceFactory,
    storageClient,
    notificationBus,
    sidekickPackageLoader,
    sidekickPackageService,
    sidekickSyncService,
    unitTypeLoader,
    turnSignalHub,
    supervisorRegistry,
    browserSessionManager,
  };
}

function buildRepositories(db: SqliteDatabase): Repositories {
  const serverRepo = new SqliteServerRepository(db);
  const windowRepo = new SqliteWindowRepository(db);
  const projectRepo = new SqliteProjectRepository(db, windowRepo);
  const providerRepo = new SqliteProviderRepository(db);
  const unitRepo = new SqliteUnitRepository(db);
  const taskTokenRepo = new SqliteTaskTokenRepository(db);
  const taskRepo = new SqliteTaskRepository(db, taskTokenRepo);
  const logRepo = new SqliteExecutionLogRepository(db);
  const projectServerRepo = new SqliteProjectServerRepository(db);
  const projectSecretRepo = new SqliteProjectSecretRepository(db);
  const storageSettingsRepo = new SqliteStorageSettingsRepository(db);
  const pushSubRepo = new SqlitePushSubscriptionRepository(db);
  const agentTurnRepo = new SqliteAgentTurnRepository(db);
  const agentWatchRepo = new SqliteAgentWatchRepository(db);
  const resourceGuardSettingsRepo = new SqliteResourceGuardSettingsRepository(db);
  const auditLogRepo = new SqliteAuditLogRepository(db);
  const auditLogService = new AuditLogService(auditLogRepo);

  return {
    serverRepo,
    windowRepo,
    projectRepo,
    providerRepo,
    unitRepo,
    taskRepo,
    taskTokenRepo,
    logRepo,
    projectServerRepo,
    projectSecretRepo,
    storageSettingsRepo,
    pushSubRepo,
    agentTurnRepo,
    agentWatchRepo,
    resourceGuardSettingsRepo,
    auditLogRepo,
    auditLogService,
  };
}

function buildPushNotificationModule(pushSubRepo: SqlitePushSubscriptionRepository): PushNotificationModule {
  const vapidKeys = getVapidKeys();
  const vapidSubject = process.env.AZITO_VAPID_SUBJECT ?? 'mailto:admin@example.com';
  const pushService = new PushNotificationService(vapidKeys, vapidSubject, pushSubRepo);
  return { vapidKeys, pushService };
}

function buildAgentUpdater(agentBundler: AgentBundler, infra: SharedInfra, repos: Repositories): AgentUpdater {
  return new AgentUpdater(agentBundler, infra.agentInstaller, repos.serverRepo, repos.taskRepo);
}

function buildApplicationServices(infra: SharedInfra, repos: Repositories, uiToken: string, scopedAuthEnabled: boolean): ApplicationServices {
  const sessionStrategyFactory = new SessionStrategyFactory(infra.agentRegistry, infra.transportFactory);
  const sessionCaptureService = new SessionCaptureService(repos.windowRepo, repos.taskRepo, repos.serverRepo, sessionStrategyFactory);
  // Constructed here (ahead of ExecuteTaskUseCase, built later in
  // buildWiring) and shared with it below — see ApplicationServices.taskEvents'
  // own doc comment for why this must be ONE instance, not one per class.
  const taskEvents = new EventEmitter();
  const originationService = new TaskOriginationService(repos.taskRepo, repos.auditLogService);
  const taskPaneEnvironmentService = new TaskPaneEnvironmentService(repos.taskTokenRepo, repos.projectSecretRepo, uiToken, scopedAuthEnabled);
  const windowRespawnService = new WindowRespawnService(repos.windowRepo, infra.tmuxClient, sessionStrategyFactory, repos.taskRepo, repos.unitRepo, infra.supervisorRegistry, repos.projectServerRepo, repos.projectRepo, infra.transportFactory, repos.logRepo, infra.unitTypeLoader, infra.sidekickPackageLoader, repos.serverRepo, repos.projectSecretRepo, taskEvents, taskPaneEnvironmentService, sessionCaptureService);
  const taskRestoreService = new TaskRestoreService({
    taskRepo: repos.taskRepo,
    serverRepo: repos.serverRepo,
    projectRepo: repos.projectRepo,
    projectServerRepo: repos.projectServerRepo,
    unitRepo: repos.unitRepo,
    windowRepo: repos.windowRepo,
    tmux: infra.tmuxClient,
    worktreeServiceFactory: infra.worktreeServiceFactory,
    transportFactory: infra.transportFactory,
    contentExtractor: infra.contentExtractor,
    logRepo: repos.logRepo,
    unitTypeLoader: infra.unitTypeLoader,
    sidekickLoader: infra.sidekickPackageLoader,
    projectSecretRepo: repos.projectSecretRepo,
    events: taskEvents,
    paneEnvService: taskPaneEnvironmentService,
  });
  const usageService = new UsageService(infra.agentRegistry);
  const agentSignalService = new AgentSignalService(repos.agentTurnRepo, infra.turnSignalHub, repos.logRepo, repos.auditLogService);
  return { sessionStrategyFactory, sessionCaptureService, windowRespawnService, taskRestoreService, usageService, agentSignalService, taskEvents, originationService, taskPaneEnvironmentService };
}

function buildExecuteTaskUseCase(
  infra: SharedInfra,
  repos: Repositories,
  appServices: ApplicationServices,
  resourceGuard: ResourceGuard,
): ExecuteTaskUseCase {
  return new ExecuteTaskUseCase(
    repos.taskRepo,
    repos.unitRepo,
    repos.serverRepo,
    repos.projectRepo,
    repos.projectServerRepo,
    infra.sidekickPackageLoader,
    repos.logRepo,
    infra.tmuxClient,
    infra.worktreeServiceFactory,
    infra.gitProvider,
    infra.transportFactory,
    infra.paneClassifier,
    infra.contentExtractor,
    infra.paneStreamFactory,
    repos.windowRepo,
    appServices.sessionStrategyFactory,
    infra.sidekickSyncService,
    repos.agentTurnRepo,
    infra.turnSignalHub,
    infra.supervisorRegistry,
    infra.unitTypeLoader,
    resourceGuard,
    repos.projectSecretRepo,
    appServices.taskEvents,
    appServices.taskPaneEnvironmentService,
  );
}

function buildSystemUpdateModule(dataPaths: DataPaths, repos: Repositories): SystemUpdateModule {
  const channelResolver = new UpdateChannelResolver(dataPaths.updateChannel);
  const stateManager = new UpdateStateManager(dataPaths.updateState, dataPaths.updateLog);
  const deployModeDetector = new DeployModeDetector();
  const systemUpdateService = new SystemUpdateService(channelResolver, stateManager, deployModeDetector, dataPaths, repos.taskRepo);
  return { deployModeDetector, systemUpdateService, channelResolver };
}

function buildAgentActivityMonitor(
  infra: SharedInfra,
  repos: Repositories,
  executeTaskUseCase: ExecuteTaskUseCase,
  sessionCaptureService: SessionCaptureService,
): AgentActivityMonitor {
  return new AgentActivityMonitor(
    executeTaskUseCase,
    repos.windowRepo,
    infra.tmuxClient,
    repos.serverRepo,
    infra.notificationBus,
    (serverName, target) => {
      const wins = repos.windowRepo.findAll().filter(
        (w) => w.serverName === serverName
          && stripPaneSuffix(w.tmuxTarget) === stripPaneSuffix(target)
          && !w.agentSessionId
          && w.workerType === 'codex',
      );
      for (const w of wins) {
        void sessionCaptureService.tryScanForWindow(w.id);
      }
    },
  );
}

// ─── Composition root ───

export async function buildWiring(db: SqliteDatabase, publicUrl: string, localUrl: string, dataPaths: DataPaths, uiToken: string): Promise<Wiring> {
  // Build agent bundle (no-op if already up to date)
  const agentBundler = new AgentBundler();
  try {
    await agentBundler.ensureBuild();
  } catch (err) {
    console.error('[startup] Agent bundle build failed (non-fatal):', (err as Error).message);
  }

  const repos = buildRepositories(db);
  const extractHost = (sshHostStr: string): { host: string; port: number } => {
    const atIdx = sshHostStr.indexOf('@');
    let rest = atIdx !== -1 ? sshHostStr.substring(atIdx + 1) : sshHostStr;
    let port = 22;
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx !== -1) {
      const p = parseInt(rest.substring(colonIdx + 1), 10);
      if (!isNaN(p) && p > 0 && p <= 65535) { port = p; rest = rest.substring(0, colonIdx); }
    }
    return { host: rest, port };
  };
  const findServerByHostPort = (host: string, port: number) => {
    return repos.serverRepo.findAll().find(s => {
      const raw = s.sshHost || s.host;
      if (!raw) return false;
      const parsed = extractHost(raw);
      return parsed.host === host && parsed.port === port;
    });
  };
  const fingerprintStore: FingerprintStore = {
    getFingerprint(host, port) {
      return findServerByHostPort(host, port)?.sshHostFingerprint ?? null;
    },
    saveFingerprint(host, port, fingerprint) {
      const srv = findServerByHostPort(host, port);
      if (srv) repos.serverRepo.updateFingerprint(srv.name, fingerprint);
    },
  };
  // Resolved once here (Resolve at the Boundary) — see scopedAuthFlag.ts's
  // doc comment for why buildServer.ts must read the SAME resolved value
  // (via wiring.scopedAuthEnabled) instead of independently re-reading
  // process.env. Moved ahead of buildSharedInfra (Issue #28 Phase C) so
  // SupervisorRegistry — constructed inside it — can be given the same
  // resolved flag instead of re-reading process.env itself.
  const scopedAuthEnabled = resolveScopedAuthEnabled();
  const infra = buildSharedInfra(agentBundler, publicUrl, localUrl, dataPaths, uiToken, db, fingerprintStore, repos.auditLogService, scopedAuthEnabled);
  const pushNotification = buildPushNotificationModule(repos.pushSubRepo);
  const agentUpdater = buildAgentUpdater(agentBundler, infra, repos);
  const appServices = buildApplicationServices(infra, repos, uiToken, scopedAuthEnabled);
  const resourceGuard = new ResourceGuard(infra.transportFactory, repos.resourceGuardSettingsRepo);
  const executeTaskUseCase = buildExecuteTaskUseCase(infra, repos, appServices, resourceGuard);
  const agentActivityMonitor = buildAgentActivityMonitor(infra, repos, executeTaskUseCase, appServices.sessionCaptureService);
  const systemUpdateModule = buildSystemUpdateModule(dataPaths, repos);

  return {
    uiToken,
    agentBundler,
    ...infra,
    ...repos,
    ...pushNotification,
    agentUpdater,
    ...appServices,
    executeTaskUseCase,
    agentActivityMonitor,
    resourceGuard,
    scopedAuthEnabled,
    ...systemUpdateModule,
  };
}
