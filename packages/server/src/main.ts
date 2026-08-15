import Fastify from 'fastify';

import { resolveDataDir, getLegacyPaths } from './shared/dataDir';
import { getReleaseInfo } from './shared/releaseInfo';
import { migrateDataIfNeeded } from './shared/dataMigration';
import { initSecretBox } from './shared/crypto/SecretBox';
import { initVapidKeyManager } from './modules/notifications/push/VapidKeyManager';
import { openDatabase } from './shared/db/Database';
import { resolveUiToken } from './shared/uiToken';
import { buildWiring } from './app/wiring';
import { buildServer } from './app/buildServer';
import { resolvePublicUrl } from './app/resolvePublicUrl';
import { RecoverStuckTasksUseCase } from './modules/tasks/recovery/RecoverStuckTasksUseCase';
import { recoverInterruptedIsolationCleanup } from './modules/servers/recoverInterruptedIsolationCleanup';
import { AgentEventStream } from './modules/servers/transport/AgentEventStream';
import { invalidateSessionCache } from './modules/tmux/routes/sessions';
import { tokenCommand } from './cli/tokenCommand';
import { authDoctorCommand } from './cli/authDoctorCommand';
import { runUpdate } from './modules/system/updateScript';

// ─── Graceful shutdown ───

const SHUTDOWN_HARD_CAP_MS = 8000;

// ─── Bootstrap ───

async function main(): Promise<void> {
  if (process.argv[2] === 'token') {
    await tokenCommand(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === 'auth' && process.argv[3] === 'doctor') {
    // Fix 1 (Issue #28 third-party review, Important): `authDoctorCommand`'s
    // task-owned-window check (checkTaskOwnedWindowsBeforeScopedAuth) reads
    // `servers.agent_token` and decrypts it via SecretBox's `open()` — but
    // `auth doctor` used to skip straight past the normal startup sequence
    // (resolveDataDir/migrateDataIfNeeded/initSecretBox happen further down,
    // AFTER this dispatch returns), so on any DB with an encrypted (`v1.*`)
    // agent token, `open()` throws "SecretBox not initialized" and crashes
    // the entire doctor run instead of reporting a single check's result.
    // Run the same data-dir resolution + migration + SecretBox init the
    // normal server startup does (but nothing heavier — no DB open, no
    // Fastify) so decryption has a key to work with.
    const doctorPaths = resolveDataDir();
    migrateDataIfNeeded(doctorPaths, getLegacyPaths());
    initSecretBox(doctorPaths.masterKey);
    await authDoctorCommand();
    return;
  }

  if (process.argv[2] === '--version') {
    const release = getReleaseInfo();
    console.log(release?.version ?? 'dev');
    return;
  }

  if (process.argv[2] === 'update-run') {
    await runUpdate(process.argv.slice(3));
    return;
  }

  const paths = resolveDataDir();
  const legacy = getLegacyPaths();

  const releaseInfo = getReleaseInfo();
  if (releaseInfo) {
    console.log(`[azito] Release mode: ${releaseInfo.version} (${releaseInfo.commit}, hash: ${releaseInfo.bundleHash})`);
    console.log(`[azito] Data directory: ${paths.dir}`);
  }

  migrateDataIfNeeded(paths, legacy);

  initSecretBox(paths.masterKey);
  initVapidKeyManager(paths.vapidKeys);

  const db = openDatabase(paths.db);
  const uiToken = resolveUiToken(paths.uiToken);

  const app = Fastify({ logger: true });
  const PORT = parseInt(process.env.PORT || '3001', 10);
  const HOST = process.env.AZITO_BIND ?? '127.0.0.1';
  if (HOST === '0.0.0.0' || HOST === '::') {
    app.log.error('AZITO_BIND must not be 0.0.0.0 or :: — bind to 127.0.0.1 or a Tailscale IP');
    process.exit(1);
  }
  const publicUrl = await resolvePublicUrl(PORT, HOST);

  const localUrl = `http://127.0.0.1:${PORT}`;
  const wiring = await buildWiring(db, publicUrl, localUrl, paths, uiToken);
  const { tmuxHookManager, agentEventStreams } = await buildServer(app, wiring, PORT);

  app.log.info(`Public URL: ${publicUrl}`);

  // ─── Start ───

  await app.listen({ port: PORT, host: HOST });

  // Graceful shutdown: app.close() runs buildServer's onClose hook (browserSessionManager.stopAll +
  // tmux hook uninstall + agent event stream stop), then exits. A hard cap forces exit if close()
  // hangs (e.g. a stuck Chromium process), and a running flag ignores a second signal during shutdown.
  // This matters for tsx watch restarts on the hub too, since BrowserSession disables playwright's
  // own SIGTERM/SIGINT handlers (see BrowserSession.ts) — without this, a hub restart during an
  // active browser session would leave an orphaned Chromium process.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down gracefully`);
    const hardCap = setTimeout(() => {
      app.log.warn('Graceful shutdown exceeded hard cap, forcing exit');
      process.exit(0);
    }, SHUTDOWN_HARD_CAP_MS);
    hardCap.unref();
    app.close().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ─── Startup: recover a stranded isolation-cleanup pending marker ───
  // Synchronous/local-only (no remote side effects — see the function's own
  // doc comment for why it deliberately does not re-run cleanup itself), so
  // it runs before the loops below rather than fire-and-forget.
  {
    const recoveredCount = recoverInterruptedIsolationCleanup(wiring.serverRepo);
    if (recoveredCount > 0) {
      app.log.warn(`Startup recovery: marked ${recoveredCount} interrupted isolation-cleanup attempt(s) as failed (retry via a true->true PUT /api/servers/:name)`);
    }
  }

  // ─── Startup: install tmux hooks + connect agent event streams ───

  for (const srv of wiring.serverRepo.findAll()) {
    if (srv.type === 'local') {
      tmuxHookManager.install(srv).catch((err) => {
        app.log.warn(`Failed to install tmux hooks on ${srv.name}: ${err}`);
      });
    }
    if (srv.type === 'agent' && srv.host && srv.agentPort && srv.agentToken) {
      const wsBase = `ws://${srv.host}:${srv.agentPort}`;
      const auth = `Bearer ${srv.agentToken}`;
      const stream = new AgentEventStream(srv.name, wsBase, auth, wiring.notificationBus, invalidateSessionCache);
      stream.start();
      agentEventStreams.push(stream);
    }
  }

  // ─── Startup GC: clean leaked linked sessions ───

  for (const srv of wiring.serverRepo.findAll()) {
    wiring.tmuxClient.cleanupLinkedSessions(srv).then((n) => {
      if (n > 0) app.log.info(`Startup GC: cleaned ${n} linked session(s) on ${srv.name}`);
    }).catch(() => {});
  }

  // ─── Startup: recover stuck tasks ───

  new RecoverStuckTasksUseCase(
    wiring.taskRepo,
    wiring.unitRepo,
    wiring.serverRepo,
    wiring.projectRepo,
    wiring.projectServerRepo,
    wiring.logRepo,
    wiring.tmuxClient,
    wiring.executeTaskUseCase,
    wiring.agentTurnRepo,
    app.log,
    wiring.unitTypeLoader,
  ).run().catch((err) => { app.log.warn(`Startup recovery failed: ${err}`); });

  // ─── Startup: check agent versions ───

  wiring.agentUpdater.checkAllServers().then((results) => {
    for (const r of results) {
      if (r.status === 'updated') app.log.info(`Agent updated on ${r.name} → ${r.currentVersion}`);
      else if (r.status === 'deferred') app.log.info(`Agent update deferred on ${r.name}: ${r.message}`);
      else if (r.status === 'error') app.log.warn(`Agent update error on ${r.name}: ${r.message}`);
    }
  }).catch(() => {});
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
