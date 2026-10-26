// ─── Dependency wiring ───
//
// Constructs all infrastructure/repository/domain/application instances via
// manual `new` (no DI container). Mirrors the former inline construction in
// main.ts; grouped into per-module factory functions for readability.

import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import type { HostEnv } from '../shared/os/hostEnv';
import { TaskTempFiles } from '../shared/os/taskTempFiles';
import type { SecretFileGuard } from '../shared/os/secretFileGuard';
import { HubGitSupport } from '../modules/git/HubGitSupport';
import * as path from 'path';
import type { SqliteDatabase } from '../shared/db/Database';
import type { DataPaths } from '../shared/dataDir';
import type { ServerConfig } from '../modules/servers/Server';
import { uiTokenEnvForServer } from '../shared/auth/uiTokenEnv';
import { SftpService } from '../modules/servers/ssh/SftpService';
import { HubRepoCache } from '../modules/git/hub-transfer/HubRepoCache';
import { RemoteBundleOps } from '../modules/git/hub-transfer/RemoteBundleOps';
import { CleanPusher } from '../modules/git/hub-transfer/CleanPusher';
import { SqliteDistributionStateRepository } from '../modules/git/hub-transfer/SqliteDistributionStateRepository';
import { FetchDistributionService } from '../modules/git/hub-transfer/FetchDistributionService';
import { PushNotaryService } from '../modules/git/hub-transfer/PushNotaryService';

import { SshClient, type FingerprintStore } from '../modules/servers/ssh/SshClient';
import { resolveSshClientEnv } from '../modules/servers/ssh/sshClientEnv';
import { TransportFactory } from '../modules/servers/transport/TransportFactory';
import { TmuxClient } from '../modules/tmux/TmuxClient';
import { MuxDriverRegistry } from '../modules/tmux/MuxDriverRegistry';
import { probeMisaoDaemon, registerMisaoDriver, resolveMisaoRuntimeForHub, type MisaoHandle, type MisaoRuntime } from '../modules/tmux/misao/misaoDriver';
import { getBundleRoot } from '../shared/releaseInfo';
import { readMisaoBundle } from '../modules/system/misao/MisaoBundle';
import { HUB_SERVICE, runCommand } from '../modules/system/serviceManager';
import { createMisaoServiceManager, createServiceManager } from '../modules/system/createServiceManager';
import { MisaoServiceService } from '../modules/system/misao/MisaoServiceService';
import { isManagedMisaoDown } from '../modules/system/misao/MisaoWindowsInstaller';
import { MisaoAgentInstaller } from '../modules/system/misao/MisaoAgentInstaller';
import { misaoWindowsUserOf, resolveInstallPrefix, resolveMisaoPaths, type MisaoPaths } from '../modules/system/misao/misaoPaths';
import { createLocalMisaoWindows } from '../modules/system/misao/misaoLocalWindows';
import { invalidateSessionCache } from '../modules/tmux/routes/sessions';
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
import { resolveWindowsAgentOptions, type WindowsAgentOptions } from '../modules/servers/agent-deploy/windowsAgentConfig';
import { AgentUpdater } from '../modules/servers/agent-deploy/AgentUpdater';
import { AgentRecoveryWatchdog } from '../modules/servers/agent-deploy/AgentRecoveryWatchdog';
import { createMisaoRootLock } from '../modules/system/misao/misaoRootLock';
import type { ProcessLock } from '../shared/processLock';
import { LocalMisaoWatchdog } from '../modules/system/misao/LocalMisaoWatchdog';
import { HostProfileError, resolveHubHostProfile, type HostProfile, type HubHostProfile } from '../shared/os/hostProfile';
import { registerTmuxDriver } from '../modules/tmux/registerTmuxDriver';
import { AgentHostRecorder } from '../modules/servers/agent-deploy/AgentHostRecorder';
import { HarnessInstaller } from '../modules/servers/agent-deploy/HarnessInstaller';
import { HarnessUpdater } from '../modules/servers/agent-deploy/HarnessUpdater';
import { TmuxInstaller } from '../modules/servers/agent-deploy/TmuxInstaller';
import { NotificationBus } from '../modules/notifications/NotificationBus';

import { SqliteServerRepository } from '../modules/servers/SqliteServerRepository';
import { SqliteServerAliasRepository } from '../modules/servers/SqliteServerAliasRepository';
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
import { KeyedMutex } from '../shared/keyedMutex';
import { TaskOriginationService } from '../modules/tasks/origination/TaskOriginationService';
import { TaskPaneEnvironmentService } from '../modules/tasks/execution/TaskPaneEnvironmentService';
import { ResourceGuard } from '../modules/servers/resources/ResourceGuard';
import { TurnSignalHub } from '../modules/tasks/turns/TurnSignalHub';
import { AgentSignalService } from '../modules/tasks/turns/AgentSignalService';
import { SidekickPackageLoader } from '../modules/sidekicks/SidekickPackageLoader';
import { SidekickPackageService } from '../modules/sidekicks/SidekickPackageService';
import { SidekickSyncService } from '../modules/sidekicks/SidekickSyncService';
import { UnitTypeLoader } from '../modules/sidekicks/UnitTypeLoader';
import { ChatCommandLoader } from '../modules/chat-commands/ChatCommandLoader';
import { SupervisorRegistry } from '../modules/supervisors/SupervisorRegistry';
import { SqliteSupervisorLaunchRepository } from '../modules/supervisors/SupervisorLaunchRepository';
import { BrowserSessionManager } from '../modules/browser/BrowserSessionManager';
import { SqliteBrowserSnapshotRepository } from '../modules/browser/SqliteBrowserSnapshotRepository';
import { SqliteBrowserGroupRepository } from '../modules/browser/SqliteBrowserGroupRepository';

import { AgentRegistry, createDefaultRegistry } from '../modules/agents/registry';

import { ExecuteTaskUseCase } from '../modules/tasks/execution/ExecuteTaskUseCase';
import type { IPrimaryWindowWaker } from '../modules/tasks/execution/IPrimaryWindowWaker';
import { AgentActivityMonitor } from '../modules/operations/AgentActivityMonitor';
import { InteractionMonitor } from '../modules/notifications/InteractionMonitor';
import { PaneHandleResolver } from '../modules/operations/PaneHandleResolver';
import { WindowRespawnService } from '../modules/windows/WindowRespawnService';
import { WindowSleepService } from '../modules/windows/WindowSleepService';
import { SessionCaptureService } from '../modules/windows/SessionCaptureService';
import { WindowActivityStatusService } from '../modules/windows/WindowActivityStatusService';
import { WindowSessionResolver } from '../modules/transcripts/WindowSessionResolver';
import { TRANSCRIPT_SOURCES } from '../modules/transcripts/sources/registry';
import { HostTranscriptSourceProvider, type TranscriptSourceProvider } from '../modules/transcripts/sources/TranscriptSourceProvider';
import { TaskRestoreService } from '../modules/tasks/TaskRestoreService';
import type { GitIdentity } from '../modules/git/ensureGitIdentity';
import { SessionStrategyFactory } from '../modules/agents/SessionStrategyFactory';
import { localAgentHomesFromEnv } from '../modules/agents/agentHomes';
import { UsageService } from '../modules/usage/UsageService';
import { UpdateChannelResolver } from '../modules/system/UpdateChannelResolver';
import { UpdateStateManager } from '../modules/system/UpdateStateManager';
import { DeployModeDetector } from '../modules/system/DeployModeDetector';
import { SystemUpdateService, resolveGithubApiBase, type WindowsUpdateHost } from '../modules/system/SystemUpdateService';
import { runCommandSpec, runHostOf } from '../shared/exec/runCommandSpec';
import { SchtasksClient, rawRunnerOf } from '../shared/os/taskScheduler/schtasks';

// ─── Module return types ───

export interface SharedInfra {
  sshClient: SshClient;
  agentInstaller: AgentInstaller;
  /** Puts the bundled misao on an agent server (through its agent). With no bundled copy (source checkout) it refuses to. */
  misaoAgentInstaller: MisaoAgentInstaller;
  harnessInstaller: HarnessInstaller;
  tmuxInstaller: TmuxInstaller;
  transportFactory: TransportFactory;
  /** Resolves where a task's signal / pipe / output / rules files live (the hub's own server: HostEnv.tmpDir). */
  taskTempFiles: TaskTempFiles;
  tmuxClient: TmuxClient;
  muxDriverRegistry: MuxDriverRegistry;
  /** Created but not started: main.ts starts it. The daemon may be absent; the driver then reports `daemon_unreachable`. */
  misao: MisaoHandle;
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
  chatCommandLoader: ChatCommandLoader;
  turnSignalHub: TurnSignalHub;
  supervisorRegistry: SupervisorRegistry;
  browserSessionManager: BrowserSessionManager;
  // Issue #29 review (7th pass), Important finding 1: ONE instance, shared
  // by servers/routes.ts's PUT handler, tmux/routes/sessions.ts's manual
  // session/window/pane routes, AND (via ApplicationServices below)
  // WindowRespawnService/TaskRestoreService/ExecuteTaskUseCase — every code
  // path that can (re)create a task-owned tmux window now serializes on the
  // same per-server-name mutex the isolation false->true transition itself
  // holds while it checks+commits, so no window-creation path can ever build
  // its env from a `ServerConfig` a concurrent transition has already
  // superseded. Constructed here (not in buildServer.ts, where it used to
  // live as a route-registration-only concern) because the application
  // services below are built first and need it too.
  serverIsolationMutex: KeyedMutex;
}

export interface Repositories {
  serverRepo: SqliteServerRepository;
  serverAliasRepo: SqliteServerAliasRepository;
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
  browserGroupRepo: SqliteBrowserGroupRepository;
}

export interface PushNotificationModule {
  vapidKeys: VapidKeys;
  pushService: PushNotificationService;
}

export interface ApplicationServices {
  sessionStrategyFactory: SessionStrategyFactory;
  sessionCaptureService: SessionCaptureService;
  transcriptSourceProvider: TranscriptSourceProvider;
  windowSessionResolver: WindowSessionResolver;
  windowActivityStatusService: WindowActivityStatusService;
  windowRespawnService: WindowRespawnService;
  windowSleepService: WindowSleepService;
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
  /** The AZITO-managed misao service. Separate from the hub's own update: a hub update never touches it. */
  misaoService: MisaoServiceService;
}

export interface Wiring extends SharedInfra, Repositories, PushNotificationModule, ApplicationServices, SystemUpdateModule {
  uiToken: string;
  webhookToken: string;
  agentBundler: AgentBundler;
  agentUpdater: AgentUpdater;
  agentRecoveryWatchdog: AgentRecoveryWatchdog;
  /** Brings back the hub's own misao when its daemon died; present only where that misao is a Windows task AZITO installs. */
  localMisaoWatchdog: LocalMisaoWatchdog | undefined;
  harnessUpdater: HarnessUpdater;
  /** Records an agent server's OS / architecture from the agent's own report (after install / update, and when reached with none recorded). */
  agentHostRecorder: AgentHostRecorder;
  executeTaskUseCase: ExecuteTaskUseCase;
  agentActivityMonitor: AgentActivityMonitor;
  interactionMonitor: InteractionMonitor;
  paneHandleResolver: PaneHandleResolver;
  resourceGuard: ResourceGuard;
  /** Shared with FetchDistributionService (its writer) — also read by projectsRoutes to render each project server's last-distribution record (Issue #87 配信状態の可視化). */
  distributionStateRepo: SqliteDistributionStateRepository;
  /** Also handed to projectsRoutes, which only checks its presence (the `service_not_wired` prerequisite stage). */
  fetchDistributionService: FetchDistributionService;
  /** Issue #28 Phase A: resolved once here (the composition root boundary) via shared/auth/scopedAuthFlag.ts, then threaded through — see that file's doc comment for why buildServer.ts reads this instead of process.env directly. */
  scopedAuthEnabled: boolean;
  harnessPrefix?: string;
  /** GIT_ASKPASS launcher and the empty hooks directory for the git commands that run on the hub's own machine. */
  hubGitSupport: HubGitSupport;
}

// ─── Per-module factories ───

function buildSharedInfra(agentBundler: AgentBundler, publicUrl: string, localUrl: string, dataPaths: DataPaths, uiToken: string, webhookToken: string, scopedAuthEnabled: boolean, misaoRuntime: MisaoRuntime, hostEnv: HostEnv, secretFileGuard: SecretFileGuard, hubHost: HubHostProfile, windowsAgent: WindowsAgentOptions, findServer: (name: string) => ServerConfig | null, db?: SqliteDatabase, fingerprintStore?: FingerprintStore, auditLogService?: AuditLogService): SharedInfra {
  const sshClient = new SshClient(resolveSshClientEnv(hostEnv, process.env), fingerprintStore);
  const misaoAgentInstaller = new MisaoAgentInstaller(readMisaoBundle(getBundleRoot()), { windowsTaskName: windowsAgent.misaoTaskName, ...optionalLocalMisao(localWindowsMisaoRoot(hostEnv), secretFileGuard, hostEnv.systemRoot) });
  // A hub with no bundled misao installs agents without it (instead of reporting a failed misao step on every install).
  const agentInstaller = new AgentInstaller(sshClient, agentBundler, windowsAgent, misaoAgentInstaller.bundledVersion !== undefined ? misaoAgentInstaller : undefined);
  const harnessInstaller = new HarnessInstaller(sshClient);
  const tmuxInstaller = new TmuxInstaller();
  const muxDriverRegistry = new MuxDriverRegistry();
  const taskTempFiles = TaskTempFiles.fromHostEnv(hostEnv);
  taskTempFiles.assertHubDirShellSafe();
  const transportFactory = new TransportFactory(publicUrl, hostEnv, taskTempFiles, hubHost);
  const tmuxClient = new TmuxClient(transportFactory, publicUrl, uiToken, localUrl, webhookToken);
  registerTmuxDriver(muxDriverRegistry, tmuxClient);
  const llmClient: ILlmClient = new CodexExecClient();
  const agentRegistry = createDefaultRegistry();
  const paneClassifier = new PaneClassifier(llmClient);
  const contentExtractor = new LlmContentExtractor(llmClient);
  const gitProvider = new GitProviderService();
  const worktreeServiceFactory = new WorktreeServiceFactory();
  const storageClient = new MinioStorageClient();
  const notificationBus = new NotificationBus();
  const misao = registerMisaoDriver(muxDriverRegistry, misaoRuntime, (serverName) => {
    invalidateSessionCache(serverName);
    notificationBus.emit({ type: 'sessions:updated', payload: { serverName } });
  }, console, { publicUrl, localUrl, webhookToken }, {
    // The server is read again on every (re)connect, so an edited host / token is used by the next attempt even when
    // the node was built from an older config.
    target: (server) => ({ connect: ({ signal }) => transportFactory.getAgentTransport(findServer(server.name) ?? server).connectMisaoRelay(signal) }),
    status: (server) => transportFactory.getAgentTransport(server).fetchMisaoStatus(),
    hostInfo: (server) => transportFactory.getAgentTransport(server).fetchHostInfo(),
    latest: findServer,
  });
  const paneStreamFactory = new PaneStreamFactory(transportFactory, (server) => misao.servers.nodeFor(server).connection);
  const sidekickPackageLoader = new SidekickPackageLoader(undefined, dataPaths.sidekicks);
  const sidekickPackageService = new SidekickPackageService(sidekickPackageLoader, dataPaths.sidekicks);
  const sidekickSyncService = new SidekickSyncService();
  const unitTypeLoader = new UnitTypeLoader();
  // ユーザー層は sidekicks と同じ起点（AZITO_DATA_DIR/data ディレクトリ直下）に置く単一 JSON ファイル
  // （Issue #338 フェーズC、設定駆動コマンドパレット）。
  const chatCommandLoader = new ChatCommandLoader(undefined, path.join(dataPaths.dir, 'chat-commands.json'));
  const turnSignalHub = new TurnSignalHub();
  const supervisorLaunchRepo = db ? new SqliteSupervisorLaunchRepository(db) : undefined;
  const supervisorRegistry = new SupervisorRegistry(supervisorLaunchRepo, auditLogService, scopedAuthEnabled);
  const browserSnapshotRepo = db ? new SqliteBrowserSnapshotRepository(db) : undefined;
  // Separate instance from `buildRepositories`'s own `browserGroupRepo`
  // (both are thin, stateless wrappers over prepared statements against the
  // same `db` handle — Repositories.browserGroupRepo backs the route-level
  // ownership check in browser/routes.ts; this one lets BrowserSessionManager
  // clean up ownership rows itself on session stop / idle-TTL group expiry,
  // Issue #28 review fix 4). `undefined` when `db` isn't wired (matches
  // `browserSnapshotRepo` right above) — BrowserSessionManager already
  // treats a missing repo as a no-op (same as the agent process, which never
  // has one at all).
  const browserGroupRepo = db ? new SqliteBrowserGroupRepository(db) : undefined;
  const browserSessionManager = new BrowserSessionManager(
    dataPaths.browserProfile,
    browserSnapshotRepo,
    browserGroupRepo,
  );
  const serverIsolationMutex = new KeyedMutex();

  return {
    sshClient,
    agentInstaller,
    misaoAgentInstaller,
    harnessInstaller,
    tmuxInstaller,
    transportFactory,
    taskTempFiles,
    tmuxClient,
    muxDriverRegistry,
    misao,
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
    chatCommandLoader,
    turnSignalHub,
    supervisorRegistry,
    browserSessionManager,
    serverIsolationMutex,
  };
}

function buildRepositories(db: SqliteDatabase, hubHost: HostProfile | null): Repositories {
  const serverRepo = new SqliteServerRepository(db, hubHost);
  const serverAliasRepo = new SqliteServerAliasRepository(db);
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
  const browserGroupRepo = new SqliteBrowserGroupRepository(db);

  return {
    serverRepo,
    serverAliasRepo,
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
    browserGroupRepo,
  };
}

function buildPushNotificationModule(pushSubRepo: SqlitePushSubscriptionRepository): PushNotificationModule {
  const vapidKeys = getVapidKeys();
  const vapidSubject = process.env.AZITO_VAPID_SUBJECT ?? 'mailto:admin@example.com';
  const pushService = new PushNotificationService(vapidKeys, vapidSubject, pushSubRepo);
  return { vapidKeys, pushService };
}

function buildAgentRecoveryWatchdog(infra: SharedInfra, repos: Repositories): AgentRecoveryWatchdog {
  const sshHostOf = (server: ServerConfig): string => {
    if (!server.sshHost) throw new Error('no SSH host is configured for this server');
    return server.sshHost;
  };
  return new AgentRecoveryWatchdog({
    listServers: () => repos.serverRepo.findAll(),
    checkAgent: async (server) => { await infra.transportFactory.getAgentTransport(server).fetchHealth(); },
    recoverAgent: async (server) => {
      if (!server.host || !server.agentToken) throw new Error('the server has no agent address or token');
      return infra.agentInstaller.recoverAgent(sshHostOf(server), server.host, server.agentToken, server.hostProfile, server.muxRuntime);
    },
    isMisaoDown: async (server) => {
      return isManagedMisaoDown(await infra.transportFactory.getAgentTransport(server).fetchMisaoStatus());
    },
    reviveMisao: (server, force) => infra.misaoAgentInstaller.reviveWindowsDaemon(infra.transportFactory.getAgentTransport(server), force),
    lock: infra.serverIsolationMutex,
    now: Date.now,
    logger: { info: (m) => console.log(`[agent-recovery] ${m}`), warn: (m) => console.warn(`[agent-recovery] ${m}`) },
  });
}

function buildLocalMisaoWatchdog(misaoService: MisaoServiceService): LocalMisaoWatchdog | undefined {
  if (!misaoService.managesWindowsDaemon()) return undefined;
  return new LocalMisaoWatchdog({
    isDown: () => misaoService.isWindowsDaemonDown(),
    revive: (force) => misaoService.reviveWindowsDaemon(force),
    now: Date.now,
    logger: { info: (m) => console.log(`[misao-recovery] ${m}`), warn: (m) => console.warn(`[misao-recovery] ${m}`) },
  });
}

function buildAgentUpdater(agentBundler: AgentBundler, infra: SharedInfra, repos: Repositories, agentHostRecorder: AgentHostRecorder): AgentUpdater {
  return new AgentUpdater(agentBundler, infra.agentInstaller, repos.serverRepo, repos.taskRepo, agentHostRecorder, infra.serverIsolationMutex, { warn: (m) => console.warn(`[agent-updater] ${m}`) });
}

// Constructed ONCE and shared between TaskRestoreService and
// ExecuteTaskUseCase (Issue #87 13th-round review, Important finding 1) —
// FetchDistributionService's own per-repo KeyedMutex only actually serializes
// concurrent distributions to the same mirror when both call sites share the
// SAME instance; two separately-constructed instances would each hold their
// own mutex and could race the same mirror.
// `distributionStateRepo` is constructed by the caller and passed in (Issue
// #87 review, forge/87-mirror follow-up, Important finding 3) — it is no
// longer FetchDistributionService's private implementation detail:
// `shouldClearRecordedDistributionRepository` (DistributionHelper.ts) needs
// the SAME instance/table to decide whether a not-required-this-run
// execute()/restore() may clear `task.distributionRepositoryId`, so
// `buildExecuteTaskUseCase`/`buildApplicationServices` (TaskRestoreService)
// must be able to read from it too.
function readHubGitIdentity(): GitIdentity | null {
  try {
    const name = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf-8' }).trim();
    const email = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf-8' }).trim();
    if (!name || !email) return null;
    return { name, email };
  } catch {
    return null;
  }
}

function buildFetchDistributionService(infra: SharedInfra, hubGitSupport: HubGitSupport, dataPaths: DataPaths, distributionStateRepo: SqliteDistributionStateRepository, hubGitIdentity: GitIdentity | null): FetchDistributionService {
  const sftpService = new SftpService(infra.sshClient);
  const hubRepoCache = new HubRepoCache(dataPaths.dir, hubGitSupport);
  const remoteBundleOps = new RemoteBundleOps();
  // sshClient passed to normalize the outer lock key's host identity (Issue
  // #87 review, 6th pass, Important finding 3) — see FetchDistributionService's
  // `sshHostResolver` constructor doc comment.
  return new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService, distributionStateRepo, infra.sshClient, hubGitIdentity);
}

function buildApplicationServices(infra: SharedInfra, repos: Repositories, uiToken: string, scopedAuthEnabled: boolean, fetchDistributionService: FetchDistributionService, distributionStateRepo: SqliteDistributionStateRepository, hubGitIdentity: GitIdentity | null, harnessPrefix?: string): ApplicationServices {
  const sessionStrategyFactory = new SessionStrategyFactory(infra.agentRegistry, infra.transportFactory, localAgentHomesFromEnv(process.env));
  const sessionCaptureService = new SessionCaptureService(repos.windowRepo, repos.taskRepo, repos.serverRepo, sessionStrategyFactory);
  // Constructed here (ahead of ExecuteTaskUseCase, built later in
  // buildWiring) and shared with it below — see ApplicationServices.taskEvents'
  // own doc comment for why this must be ONE instance, not one per class.
  const taskEvents = new EventEmitter();
  const originationService = new TaskOriginationService(repos.taskRepo, repos.auditLogService);
  const taskPaneEnvironmentService = new TaskPaneEnvironmentService(repos.taskTokenRepo, repos.projectSecretRepo, uiToken, scopedAuthEnabled, repos.auditLogService);
  const uiTokenEnvFn = (server: ServerConfig) => uiTokenEnvForServer(uiToken, server);
  const windowRespawnService = new WindowRespawnService(repos.windowRepo, infra.muxDriverRegistry, sessionStrategyFactory, repos.taskRepo, repos.unitRepo, infra.supervisorRegistry, repos.projectServerRepo, repos.projectRepo, infra.transportFactory, repos.logRepo, infra.unitTypeLoader, infra.sidekickPackageLoader, repos.serverRepo, repos.projectSecretRepo, taskEvents, taskPaneEnvironmentService, infra.serverIsolationMutex, scopedAuthEnabled, uiTokenEnvFn, sessionCaptureService, harnessPrefix);
  const windowSleepService = new WindowSleepService(repos.windowRepo, infra.muxDriverRegistry, sessionStrategyFactory, repos.serverRepo);
  const taskRestoreService = new TaskRestoreService({
    taskRepo: repos.taskRepo,
    serverRepo: repos.serverRepo,
    projectRepo: repos.projectRepo,
    projectServerRepo: repos.projectServerRepo,
    unitRepo: repos.unitRepo,
    windowRepo: repos.windowRepo,
    muxDriverRegistry: infra.muxDriverRegistry,
    sessionStrategyFactory,
    worktreeServiceFactory: infra.worktreeServiceFactory,
    transportFactory: infra.transportFactory,
    contentExtractor: infra.contentExtractor,
    logRepo: repos.logRepo,
    unitTypeLoader: infra.unitTypeLoader,
    sidekickLoader: infra.sidekickPackageLoader,
    projectSecretRepo: repos.projectSecretRepo,
    events: taskEvents,
    paneEnvService: taskPaneEnvironmentService,
    serverIsolationMutex: infra.serverIsolationMutex,
    scopedAuthEnabled,
    fetchDistributionService,
    distributionStateRepo,
    hubGitIdentity,
  });
  // windowSessionResolver / windowActivityStatusService: shared by transcriptsRoutes
  // (session resolution), windowsRoutes (GET /api/windows/activity-status, diagnostics)
  // and AgentActivityMonitor's Tier 4 probe — a single instance keeps the ps/tmux
  // lookups (and their cache) to one per process.
  const transcriptSourceProvider = new HostTranscriptSourceProvider(TRANSCRIPT_SOURCES, infra.transportFactory);
  const windowSessionResolver = new WindowSessionResolver(repos.taskRepo, infra.muxDriverRegistry, repos.serverRepo, transcriptSourceProvider, sessionCaptureService, infra.transportFactory);
  const windowActivityStatusService = new WindowActivityStatusService(repos.windowRepo, repos.serverRepo, windowSessionResolver);
  const usageService = new UsageService(infra.agentRegistry);
  const agentSignalService = new AgentSignalService(repos.agentTurnRepo, infra.turnSignalHub, repos.logRepo, repos.auditLogService);
  return {
    sessionStrategyFactory, sessionCaptureService, transcriptSourceProvider, windowSessionResolver, windowActivityStatusService,
    windowRespawnService, windowSleepService, taskRestoreService, usageService, agentSignalService, taskEvents,
    originationService, taskPaneEnvironmentService,
  };
}

function buildExecuteTaskUseCase(
  infra: SharedInfra,
  repos: Repositories,
  appServices: ApplicationServices,
  resourceGuard: ResourceGuard,
  scopedAuthEnabled: boolean,
  fetchDistributionService: FetchDistributionService,
  distributionStateRepo: SqliteDistributionStateRepository,
  dataPaths: DataPaths,
  hubGitSupport: HubGitSupport,
  hubGitIdentity: GitIdentity | null,
  harnessPrefix: string,
): ExecuteTaskUseCase {

  const sftpService = new SftpService(infra.sshClient);
  const remoteBundleOps = new RemoteBundleOps();
  const cleanPusher = new CleanPusher(hubGitSupport);
  const hubRepoCache = new HubRepoCache(dataPaths.dir, hubGitSupport);
  const pushNotaryService = new PushNotaryService(remoteBundleOps, sftpService, cleanPusher, infra.gitProvider, hubRepoCache);

  return new ExecuteTaskUseCase(
    repos.taskRepo,
    repos.unitRepo,
    repos.serverRepo,
    repos.projectRepo,
    repos.projectServerRepo,
    infra.sidekickPackageLoader,
    repos.logRepo,
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
    infra.serverIsolationMutex,
    scopedAuthEnabled,
    (taskId) => appServices.windowSleepService.sleepTaskWindows(taskId),
    pushNotaryService,
    fetchDistributionService,
    distributionStateRepo,
    infra.muxDriverRegistry,
    // Issue #274: adapter from WindowRespawnService to IPrimaryWindowWaker,
    // avoiding a direct WindowRespawnService import in ExecuteTaskUseCase
    // (dependency direction: tasks → windows would be a layer violation).
    {
      wake: (windowId, serverName, opts) =>
        appServices.windowRespawnService.wakeWindow(windowId, serverName, opts),
      findRunningSession: (taskId, agentSessionId, serverName) =>
        appServices.windowRespawnService.findRunningSessionForTask(taskId, agentSessionId, serverName),
    } satisfies IPrimaryWindowWaker,
    infra.taskTempFiles,
    harnessPrefix,
    hubGitIdentity,
  );
}

/** The folder of this hub's own Windows misao, or undefined where it is not one (the reason a prefix is unusable is reported by buildMisaoService). */
function localWindowsMisaoRoot(hostEnv: HostEnv): string | undefined {
  const windowsUser = misaoWindowsUserOf(hostEnv.platform);
  const prefix = resolveInstallPrefix(getBundleRoot());
  if (!windowsUser || !prefix) return undefined;
  try {
    return resolveMisaoPaths(prefix, windowsUser).root;
  } catch {
    return undefined;
  }
}

function optionalLocalMisao(root: string | undefined, guard: SecretFileGuard, systemRoot: string | undefined): { localMisao?: { root: string; lock: ProcessLock } } {
  if (root === undefined) return {};
  if (!systemRoot) throw new Error('%SystemRoot% is not set, so the lock holder check (PowerShell) cannot be located');
  return { localMisao: { root, lock: createMisaoRootLock(root, guard, systemRoot) } };
}

function buildMisaoService(misao: MisaoHandle, hostEnv: HostEnv, secretFileGuard: SecretFileGuard): MisaoServiceService {
  const bundleRoot = getBundleRoot();
  const prefix = resolveInstallPrefix(bundleRoot);
  const windowsUser = misaoWindowsUserOf(hostEnv.platform);
  let paths: MisaoPaths | null = null;
  let pathsError: string | undefined;
  try {
    paths = prefix ? resolveMisaoPaths(prefix, windowsUser) : null;
  } catch (err) {
    // A prefix too long for the daemon's socket must not stop a hub that already runs from it: report it on the misao row.
    pathsError = err instanceof Error ? err.message : String(err);
    console.warn(`[misao] the managed misao service is unavailable: ${pathsError}`);
  }
  const serviceManager = createMisaoServiceManager(hostEnv, runCommand);
  return new MisaoServiceService({
    paths,
    ...(pathsError ? { pathsError } : {}),
    bundle: readMisaoBundle(bundleRoot),
    controller: 'manager' in serviceManager ? serviceManager.manager : null,
    ...('error' in serviceManager ? { controllerError: serviceManager.error.message } : {}),
    env: process.env,
    homeDir: hostEnv.homeDir,
    secretFileGuard,
    ...(windowsUser && paths ? { windows: createLocalMisaoWindows(hostEnv, paths, windowsUser.userName, process.env, secretFileGuard) } : {}),
    hub: { probeDaemon: () => probeMisaoDaemon(misao.connection), socketPath: misao.socketPath },
  });
}

function buildSystemUpdateModule(dataPaths: DataPaths, repos: Repositories, misao: MisaoHandle, hostEnv: HostEnv, secretFileGuard: SecretFileGuard, launchedByTaskScheduler: boolean): SystemUpdateModule {
  const channelResolver = new UpdateChannelResolver(dataPaths.updateChannel, secretFileGuard);
  const stateManager = new UpdateStateManager(dataPaths.updateState, dataPaths.updateLog, secretFileGuard);
  const deployModeDetector = new DeployModeDetector(hostEnv.homeDir, launchedByTaskScheduler, hostEnv.arch);
  const hubService = createServiceManager(hostEnv, HUB_SERVICE, runCommand);
  // Windows updates through a one-shot task of their own: the means to register and start it, resolved here once.
  const windowsUpdate: WindowsUpdateHost | null = hostEnv.platform === 'win32' && hostEnv.systemRoot
    ? { launcher: { client: new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(hostEnv), rawOutput: true })), hostEnv), guard: secretFileGuard, run: (spec) => runCommandSpec(spec, runHostOf(hostEnv)) }, systemRoot: hostEnv.systemRoot, env: process.env }
    : null;
  const systemUpdateService = new SystemUpdateService(
    channelResolver, stateManager, deployModeDetector, dataPaths, repos.taskRepo, 'manager' in hubService ? hubService.manager : null,
    { platform: hostEnv.platform, arch: hostEnv.arch, bundleRoot: getBundleRoot() },
    { githubApiBase: resolveGithubApiBase(process.env), windowsUpdate },
  );
  return { deployModeDetector, systemUpdateService, channelResolver, misaoService: buildMisaoService(misao, hostEnv, secretFileGuard) };
}

function buildAgentActivityMonitor(
  infra: SharedInfra,
  repos: Repositories,
  executeTaskUseCase: ExecuteTaskUseCase,
  sessionCaptureService: SessionCaptureService,
  processProbe: WindowActivityStatusService,
  paneHandleResolver: PaneHandleResolver,
  muxDriverRegistry: MuxDriverRegistry,
): AgentActivityMonitor {
  return new AgentActivityMonitor(
    executeTaskUseCase,
    repos.windowRepo,
    muxDriverRegistry,
    repos.serverRepo,
    infra.notificationBus,
    processProbe,
    (serverName, target) => {
      const wins = repos.windowRepo.findAll().filter(
        (w) => w.serverName === serverName
          && w.tmuxTarget === target
          && !w.agentSessionId
          && w.workerType === 'codex',
      );
      for (const w of wins) {
        void sessionCaptureService.tryScanForWindow(w.id);
      }
    },
    paneHandleResolver,
    (serverName, target, windowId, from, to, event) => {
      console.log(`[session-update] window=${windowId} ${(from ?? 'null').slice(0, 8)}→${to.slice(0, 8)} event=${event} server=${serverName} target=${target}`);
    },
  );
}

// ─── Composition root ───

export async function buildWiring(db: SqliteDatabase, publicUrl: string, localUrl: string, dataPaths: DataPaths, uiToken: string, webhookToken: string, hostEnv: HostEnv, secretFileGuard: SecretFileGuard, launchedByTaskScheduler: boolean): Promise<Wiring> {
  // Build agent bundle (no-op if already up to date)
  const agentBundler = new AgentBundler();
  try {
    await agentBundler.ensureBuild();
  } catch (err) {
    console.error('[startup] Agent bundle build failed (non-fatal):', (err as Error).message);
  }

  // The hub's own OS / architecture, resolved once here. A hub on an unsupported host still starts; what needs the host refuses with the reason.
  const hubHost = resolveHubHostProfile(hostEnv);
  const repos = buildRepositories(db, hubHost instanceof HostProfileError ? null : hubHost);
  const misaoRuntime = await resolveMisaoRuntimeForHub(
    { env: process.env, homeDir: hostEnv.homeDir, shell: hostEnv.platform === 'win32' ? process.env.ComSpec ?? null : process.env.SHELL || '/bin/bash', hubHost },
    repos.serverRepo.findAll().some((s) => s.type === 'local' && s.defaultMux === 'misao'),
    console,
  );
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
  // '' = no prefix. Resolved once here and handed to everything that names the harness folder (install, prompt azitoctl path).
  const harnessPrefix = process.env.AZITO_HARNESS_PREFIX ?? '';
  const infra = buildSharedInfra(agentBundler, publicUrl, localUrl, dataPaths, uiToken, webhookToken, scopedAuthEnabled, misaoRuntime, hostEnv, secretFileGuard, hubHost, resolveWindowsAgentOptions(process.env), (name) => repos.serverRepo.findByName(name), db, fingerprintStore, repos.auditLogService);
  const pushNotification = buildPushNotificationModule(repos.pushSubRepo);
  const agentHostRecorder = new AgentHostRecorder(repos.serverRepo, infra.transportFactory, Date.now, console);
  const agentUpdater = buildAgentUpdater(agentBundler, infra, repos, agentHostRecorder);
  const agentRecoveryWatchdog = buildAgentRecoveryWatchdog(infra, repos);
  const harnessUpdater = new HarnessUpdater(
    infra.harnessInstaller, infra.transportFactory, repos.serverRepo,
    { webhookToken, uiToken, harnessPrefix },
    infra.serverIsolationMutex,
    { info: (m) => console.log(`[harness-updater] ${m}`), warn: (m) => console.warn(`[harness-updater] ${m}`) },
  );
  // Constructed here, once, and passed to both `buildFetchDistributionService`
  // (which writes to it on every successful distribution) and
  // `buildApplicationServices`/`buildExecuteTaskUseCase` (which read from it
  // via `shouldClearRecordedDistributionRepository` — Issue #87 review,
  // forge/87-mirror follow-up, Important finding 3) — a single shared
  // instance, not two separately-constructed repositories over the same
  // table.
  const distributionStateRepo = new SqliteDistributionStateRepository(db);
  const hubGitIdentity = readHubGitIdentity();
  const hubGitSupport = new HubGitSupport(hostEnv, secretFileGuard, path.join(dataPaths.dir, 'git-support'));
  const fetchDistributionService = buildFetchDistributionService(infra, hubGitSupport, dataPaths, distributionStateRepo, hubGitIdentity);
  const appServices = buildApplicationServices(infra, repos, uiToken, scopedAuthEnabled, fetchDistributionService, distributionStateRepo, hubGitIdentity, harnessPrefix);
  const resourceGuard = new ResourceGuard(infra.transportFactory, repos.resourceGuardSettingsRepo);
  const executeTaskUseCase = buildExecuteTaskUseCase(infra, repos, appServices, resourceGuard, scopedAuthEnabled, fetchDistributionService, distributionStateRepo, dataPaths, hubGitSupport, hubGitIdentity, harnessPrefix);
  const paneHandleResolver = new PaneHandleResolver(infra.muxDriverRegistry, repos.windowRepo, repos.serverRepo);
  const agentActivityMonitor = buildAgentActivityMonitor(infra, repos, executeTaskUseCase, appServices.sessionCaptureService, appServices.windowActivityStatusService, paneHandleResolver, infra.muxDriverRegistry);
  executeTaskUseCase.setActivitySource(agentActivityMonitor);
  const interactionMonitor = new InteractionMonitor(repos.windowRepo, Date.now, paneHandleResolver);
  const systemUpdateModule = buildSystemUpdateModule(dataPaths, repos, infra.misao, hostEnv, secretFileGuard, launchedByTaskScheduler);

  return {
    uiToken,
    webhookToken,
    agentBundler,
    ...infra,
    ...repos,
    ...pushNotification,
    agentUpdater,
    agentRecoveryWatchdog,
    localMisaoWatchdog: buildLocalMisaoWatchdog(systemUpdateModule.misaoService),
    harnessUpdater,
    agentHostRecorder,
    ...appServices,
    executeTaskUseCase,
    agentActivityMonitor,
    interactionMonitor,
    paneHandleResolver,
    resourceGuard,
    scopedAuthEnabled,
    harnessPrefix,
    hubGitSupport,
    distributionStateRepo,
    fetchDistributionService,
    ...systemUpdateModule,
  };
}
