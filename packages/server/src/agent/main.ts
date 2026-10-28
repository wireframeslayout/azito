import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { EventEmitter } from 'node:events';
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCurrentHostEnv, type HostEnv } from '../shared/os/hostEnv';
import { resolveRealPath } from '../shared/os/realPath';
import { resolveTmuxRuntime } from '../modules/servers/transport/TmuxRuntime';
import { LocalTransport } from '../modules/servers/transport/LocalTransport';
import type { MuxRuntime } from '../modules/servers/Server';
import type { WebSocket } from 'ws';

import agentRoutes from './routes';
import { handleAgentTerminal } from '../modules/tmux/ws/agentTerminalHandler';
import { muxRefFromTmuxTarget, parseMuxRef, type MuxRef, type PaneOrdinal } from '@azito/shared';
import { HOOK_EVENTS, buildHookValue, buildHookSetArgs, buildHookUnsetArgs } from '../modules/tmux/tmuxHooks';
import { handleFileTail } from '../modules/files/ws/fileTailHandler';
import { ManagedStreamFiles } from '../modules/files/ws/ManagedStreamFiles';
import paneStreamRoutes from './paneStreamRoutes';
import { TaskTempFiles } from '../shared/os/taskTempFiles';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { BrowserSessionManager } from '../modules/browser/BrowserSessionManager';
import { handleBrowserConnection } from '../modules/browser/ws/browserHandler';
import { handleDevtoolsRelay } from '../modules/browser/devtools';
import { createMisaoRelay } from './misaoRelay';
import misaoRoutes from './misaoRoutes';
import hostRoutes from './hostRoutes';
import processRoutes from './processRoutes';
import hostResourcesRoutes from './hostResourcesRoutes';
import fileOpsRoutes from './fileOpsRoutes';
import { LocalFileOps, localFileOpsHost } from '../shared/fs/LocalFileOps';
import transcriptRoutes from './transcriptRoutes';
import { agentAuthHook } from './authHook';
import { listenWithRetry } from './listenRetry';
import { processExists, readWindowsProcessCreation, startParentWatch } from './parentWatch';
import { TRANSCRIPT_READERS } from '../modules/transcripts/sources/registry';
import { resolveAgentMisaoSocket, type AgentMisaoHost, type AgentMisaoSocket, type AgentMisaoWindowsHost } from '../modules/servers/transport/agentMisaoSocket';
import { MISAO_WINDOWS_DIR, parseHomeRelativeDir } from '../modules/servers/agent-deploy/windowsAgentConfig';
import { buildServicePath } from '../modules/system/misao/misaoPaths';
import { serializeRequestForLog } from '../shared/redactUrlSecrets';
import { toHostProfile } from '../shared/os/hostProfile';
import { runCommandSpec, runHostOf } from '../shared/exec/runCommandSpec';
import { listProcessesWith } from '../shared/os/processList';
import { measureHostResources, systemDriveOf } from '../shared/os/hostResources';
import { resolveLoginShell } from '../shared/os/loginShell';

// ─── Fatal errors ───

/**
 * A fatal error before the server's own logger exists. A task has nowhere to send stderr, so when the settings name a log file
 * (`AZITO_AGENT_LOG_FILE`) the error is appended there too: otherwise the log a failed install points to would be empty.
 */
function reportFatal(message: string): void {
  console.error(message);
  const logFile = process.env.AZITO_AGENT_LOG_FILE;
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify({ level: 60, time: Date.now(), msg: message })}\n`);
  } catch (err) {
    console.error(`Could not write to AZITO_AGENT_LOG_FILE (${logFile}): ${(err as Error).message}`);
  }
}

// ─── Environment validation ───

const bind = process.env.AZITO_AGENT_BIND;
if (!bind) {
  reportFatal('AZITO_AGENT_BIND is required');
  process.exit(1);
}
if (bind === '0.0.0.0') {
  reportFatal('AZITO_AGENT_BIND must not be 0.0.0.0 — bind to a Tailscale IP instead');
  process.exit(1);
}
/** Same value as `bind`, restated so its non-undefined type survives into main(). */
const BIND_ADDRESS: string = bind;

const token = process.env.AZITO_AGENT_TOKEN;
if (!token) {
  reportFatal('AZITO_AGENT_TOKEN is required');
  process.exit(1);
}

const verifyToken = createTokenVerifier(token);

// ─── Agent version ───
// A build-time content hash of the bundled payload, written to version.txt alongside
// azito-agent.cjs by scripts/build-agent.ts (see AgentBundler.getBundleHash()). When
// running unbundled from source (local dev via tsx), that file does not exist — fall
// back to the git SHA.

function resolveVersion(): string {
  try {
    return fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf-8').trim();
  } catch {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { timeout: 3000 }).toString().trim();
    } catch { return 'unknown'; }
  }
}
const agentVersion = resolveVersion();

/**
 * What a Windows agent adds to its misao report: where the system programs are, the account name (the named pipe is named
 * after it) and the misao folder, `<home>\<AZITO_MISAO_DIR>` (the default unless the hub's settings file names another one for a
 * trial). A Windows process without `%SystemRoot%` is refused: the install would have no `conhost.exe` to name.
 */
function describeWindowsMisaoHost(hostEnv: HostEnv): AgentMisaoWindowsHost {
  if (!hostEnv.systemRoot) throw new Error('%SystemRoot% is not set, so the agent cannot tell the hub where the Windows programs are');
  return {
    systemRoot: hostEnv.systemRoot,
    userName: os.userInfo().username,
    // In its real spelling (8.3 names expanded), resolved here once: the pipe name and the task's paths are made from what is reported.
    misaoRoot: resolveRealPath(path.win32.join(hostEnv.homeDir, parseHomeRelativeDir(process.env.AZITO_MISAO_DIR || MISAO_WINDOWS_DIR, 'AZITO_MISAO_DIR'))),
  };
}

/** What the hub's misao installer needs to know about this host: its OS / architecture (to pick the binary), the node this agent runs on, and its PATH. */
function describeMisaoHost(hostEnv: HostEnv, windows: AgentMisaoWindowsHost | undefined): AgentMisaoHost {
  return {
    homeDir: hostEnv.homeDir,
    nodePath: hostEnv.execPath,
    servicePath: buildServicePath(process.env, hostEnv.homeDir, fs.existsSync),
    platform: hostEnv.platform,
    arch: hostEnv.arch,
    ...(windows ? { windows } : {}),
  };
}

// ─── Graceful shutdown ───

const SHUTDOWN_HARD_CAP_MS = 8000;
const PARENT_WATCH_INTERVAL_MS = 3000;
const PARENT_VERIFY_INTERVAL_MS = 30_000;

// ─── Bootstrap ───

async function main(): Promise<void> {
  const hostEnv = resolveCurrentHostEnv();
  const agentHostProfile = toHostProfile(hostEnv.platform, hostEnv.arch);
  const startedAt = Date.now();
  // A Windows agent runs as a Task Scheduler task, which has nowhere to send its output: its settings name a log file.
  const logFile = process.env.AZITO_AGENT_LOG_FILE;
  const app = Fastify({
    logger: {
      serializers: { req: serializeRequestForLog },
      ...(logFile ? { file: logFile } : {}),
    },
  });
  // tmux does not exist on Windows: the agent runs without it there. The pane server of a Windows host is misao (a named pipe).
  const hasTmux = hostEnv.platform !== 'win32';
  const agentEventBus = new EventEmitter();
  const browserSessionManager = new BrowserSessionManager(
    path.resolve(hostEnv.homeDir, '.azito', 'browser-profile'),
  );

  await app.register(websocket);

  // Health endpoint (no auth) + tmux hook receiver + browser routes
  await app.register(agentRoutes, {
    agentVersion, startedAt, agentEventBus, browserSessionManager, bindAddress: BIND_ADDRESS, homeDir: hostEnv.homeDir, hostProfile: agentHostProfile, runHost: runHostOf(hostEnv),
  });

  // Auth hook for all routes except /health and /api/hooks/tmux (localhost-only)
  app.addHook('onRequest', agentAuthHook(verifyToken));

  const muxRuntime = (process.env.AZITO_MUX_RUNTIME as MuxRuntime) || 'system';
  // The tmux endpoints (/api/tmux, mode=terminal) are tmux's. misao is reached through its own relay (mode=misao).
  const muxKind = 'tmux';
  const hookRt = resolveTmuxRuntime(muxRuntime, hostEnv.homeDir);

  const agentTransport = new LocalTransport(hookRt, process.env.AZITO_URL ?? '', hostEnv, TaskTempFiles.fromHostEnv(hostEnv), agentHostProfile);

  // Files the hub has registered for tailing (`/ws?mode=file-tail` serves nothing else). The hub names them under the temp folder this agent reports
  // (`GET /api/host`); a Windows host has no /tmp.
  const managedStreamFiles = new ManagedStreamFiles(hostEnv.platform, hostEnv.platform === 'win32' ? [hostEnv.tmpDir] : ['/tmp', hostEnv.tmpDir], { logger: app.log });
  await app.register(paneStreamRoutes, { managed: managedStreamFiles });

  // The misao daemon's socket (a named pipe on Windows) is fixed here, at startup, from the agent's own environment. A setting that
  // cannot be a socket path disables the relay (tmux keeps working) rather than stopping the agent.
  let windowsMisao: AgentMisaoWindowsHost | undefined;
  let misaoSocket: AgentMisaoSocket | null = null;
  try {
    if (hostEnv.platform === 'win32') windowsMisao = describeWindowsMisaoHost(hostEnv);
    misaoSocket = resolveAgentMisaoSocket(process.env, hostEnv.homeDir, windowsMisao);
  } catch (err) {
    app.log.warn(`misao relay disabled: ${(err as Error).message}`);
  }
  const misaoHost = describeMisaoHost(hostEnv, windowsMisao);
  const relayMisao = createMisaoRelay(misaoSocket, app.log);

  // Registered after the auth hook above, so it is covered by it like every other /api route.
  await app.register(misaoRoutes, { socket: misaoSocket, host: misaoHost });
  // The host's own report (OS, architecture, default shell) for the hub, behind the same token check. A Windows host's default shell is its command interpreter (%ComSpec%), the one misao itself starts without a setting.
  await app.register(hostRoutes, { host: { platform: hostEnv.platform, arch: hostEnv.arch, shell: hostEnv.platform === 'win32' ? process.env.ComSpec || null : resolveLoginShell(process.env), homeDir: hostEnv.homeDir, tmpDir: hostEnv.tmpDir, execPath: process.execPath } });
  // The processes of this host, for the hub's agent detection and resource measurement (one list for every OS).
  const processRunHost = runHostOf(hostEnv);
  await app.register(processRoutes, { listProcesses: () => listProcessesWith(hostEnv.platform, (spec) => runCommandSpec(spec, processRunHost)) });
  // Memory and disk of this host from Node, for the hub's resource guard on a Windows agent (no shell, no loadavg). The disk is the system drive.
  const resourceDiskPath = systemDriveOf(hostEnv.systemRoot);
  await app.register(hostResourcesRoutes, { measure: () => measureHostResources(resourceDiskPath) });
  // File operations on this host (list / read / write / create / remove / rename / realpath / which), the hub's files API for an agent server.
  await app.register(fileOpsRoutes, { ops: new LocalFileOps(localFileOpsHost(hostEnv)) });

  // Conversation logs (Claude Code / Codex JSONL) for the hub's chat mode. Registered after the auth hook, so it is
  // covered by it; reads only this host's own agent session directories, addressed by agent type + session id.
  await app.register(transcriptRoutes, { readers: TRANSCRIPT_READERS });

  // WebSocket routes
  await app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
      const url = new URL(request.url, 'http://localhost');
      const mode = url.searchParams.get('mode');

      if (mode === 'terminal') {
        const refParam = url.searchParams.get('ref');
        const paneParam = url.searchParams.get('pane');
        const target = url.searchParams.get('target');
        const cols = parseInt(url.searchParams.get('cols') || '120', 10);
        const rows = parseInt(url.searchParams.get('rows') || '40', 10);

        let ref: MuxRef;
        if (refParam) {
          try {
            ref = parseMuxRef(decodeURIComponent(refParam));
            if (ref.kind !== muxKind) throw new Error('ref kind does not match agent mux');
          } catch {
            socket.send(JSON.stringify({ error: 'Invalid ref parameter' }));
            socket.close();
            return;
          }
        } else if (target) {
          ref = muxRefFromTmuxTarget(target);
        } else {
          socket.send(JSON.stringify({ error: 'ref or target required' }));
          socket.close();
          return;
        }
        const ordinal = (paneParam ? Number(paneParam) : 1) as PaneOrdinal;

        handleAgentTerminal(socket, ref, ordinal, cols, rows, agentTransport);
        return;
      }

      if (mode === 'misao') {
        // Same token check as every route (the onRequest hook above). Relays to this agent's own socket only.
        relayMisao(socket);
        return;
      }

      if (mode === 'file-tail') {
        const filePath = url.searchParams.get('path');
        if (!filePath) {
          socket.send(JSON.stringify({ error: 'path required' }));
          socket.close();
          return;
        }
        handleFileTail(socket, filePath, managedStreamFiles);
        return;
      }

      if (mode === 'browser') {
        const hubOrigin = `http://${bind}:${PORT}`;
        const rawGroupId = url.searchParams.get('group');
        const groupId = rawGroupId && /^[A-Za-z0-9_-]{1,64}$/.test(rawGroupId) ? rawGroupId : 'default';
        const rawTabId = url.searchParams.get('page');
        const tabId = rawTabId && /^[A-Za-z0-9_-]{1,64}$/.test(rawTabId) ? rawTabId : 't1';
        handleBrowserConnection(socket, browserSessionManager, 'agent', groupId, tabId, hubOrigin);
        return;
      }

      if (mode === 'devtools') {
        const devTarget = url.searchParams.get('target');
        if (!devTarget) {
          socket.send(JSON.stringify({ error: 'target required' }));
          socket.close();
          return;
        }
        handleDevtoolsRelay(socket, devTarget);
        return;
      }

      if (mode === 'events') {
        const onTmuxEvent = (data: { event: string }) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'tmux-hook', event: data.event }));
          }
        };
        const onBrowserOpened = (data: { groupId: string; tabId: string; url: string | null; taskId?: number; label?: string }) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'browser-opened', groupId: data.groupId, tabId: data.tabId, url: data.url, taskId: data.taskId, label: data.label }));
          }
        };
        agentEventBus.on('tmux-event', onTmuxEvent);
        agentEventBus.on('browser-opened', onBrowserOpened);
        socket.on('close', () => {
          agentEventBus.off('tmux-event', onTmuxEvent);
          agentEventBus.off('browser-opened', onBrowserOpened);
        });
        return;
      }

      socket.send(JSON.stringify({ error: 'Unknown mode' }));
      socket.close();
    });
  });

  const PORT = parseInt(process.env.PORT || '3002', 10);
  const hookBase = `http://${bind}:${PORT}/api/hooks/tmux`;
  const hookEvents = HOOK_EVENTS;

  // Cleanup tmux hooks and browser on shutdown (must register before listen — Fastify rejects addHook after ready)
  let hookInstallInterval: ReturnType<typeof setInterval> | null = null;
  app.addHook('onClose', async () => {
    if (hookInstallInterval) {
      clearInterval(hookInstallInterval);
      hookInstallInterval = null;
    }
    await browserSessionManager.stopAll();
    for (const event of hasTmux ? hookEvents : []) {
      await new Promise<void>((resolve) => {
        execFile(hookRt.bin, [...hookRt.baseArgs, ...buildHookUnsetArgs(event)], { timeout: 5000 }, () => resolve());
      });
    }
  });

  // The Tailscale IP may not exist yet right after a logon or boot: wait for it (EADDRNOTAVAIL only) instead of ending. A
  // termination signal while waiting ends the agent at once; the regular handlers below take over once it listens.
  const startupAbort = new AbortController();
  const abortStartup = (): void => startupAbort.abort();
  const startupSignals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const sig of startupSignals) process.once(sig, abortStartup);
  let listenResult: Awaited<ReturnType<typeof listenWithRetry>>;
  try {
    listenResult = await listenWithRetry({
      listen: () => app.listen({ port: PORT, host: bind }),
      bind: BIND_ADDRESS,
      port: PORT,
      log: app.log,
      signal: startupAbort.signal,
    });
  } finally {
    for (const sig of startupSignals) process.removeListener(sig, abortStartup);
  }
  if (listenResult === 'aborted') {
    app.log.info('Stopped while waiting for the listen address, exiting');
    await app.close();
    process.exit(0);
  }

  // Graceful shutdown: app.close() runs the onClose hook above (browserSessionManager.stopAll +
  // tmux hook cleanup + interval clear), then exits. A hard cap forces exit if close() hangs
  // (e.g. a stuck Chromium process), and a running flag ignores a second signal during shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
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

  // A Windows agent runs under `conhost.exe --headless` (see the task the hub registers), and the Task Scheduler's "End" ends only
  // that conhost: the agent would be left running with a valid token. Its settings ask it to follow its parent, so when the
  // parent is gone it shuts down. Only when asked: a `node azito-agent.cjs` started by hand has no such setting.
  if (hostEnv.platform === 'win32' && process.env.AZITO_AGENT_EXIT_WITH_PARENT === '1') {
    const systemRoot = hostEnv.systemRoot;
    // The 3 s probe starts at once. The parent's creation time is read in the background and again every 30 s, so that a process id
    // handed to another process after the parent ended is noticed (the probe alone would take it for the parent). If it cannot be
    // read, only the existence of the pid is watched (said once): then the worst case is an agent that stays up (the hub's stop
    // sweeps it), never one that ends early.
    startParentWatch({
      pid: process.ppid,
      aliveIntervalMs: PARENT_WATCH_INTERVAL_MS,
      verifyIntervalMs: PARENT_VERIFY_INTERVAL_MS,
      isAlive: processExists,
      readCreation: (pid) => (systemRoot ? readWindowsProcessCreation(systemRoot, pid) : Promise.resolve(null)),
      onGone: shutdown,
      onUnverifiable: (message) => app.log.warn(message),
      onVerifiable: (message) => app.log.info(message),
    });
  }

  // Install tmux hooks to notify on window/pane changes. `set-hook -g` is idempotent, so this is
  // re-run periodically to survive a tmux server that starts/restarts after the agent (in which case
  // the initial install fails because tmux isn't up yet, and the next periodic pass installs it).
  let lastInstallFailed: boolean | null = null;
  const installTmuxHooks = (): void => {
    let pending = hookEvents.length;
    let anyFailed = false;
    for (const event of hookEvents) {
      const hookValue = buildHookValue(hookBase, event);
      execFile(hookRt.bin, [...hookRt.baseArgs, ...buildHookSetArgs(event, hookValue)], { timeout: 5000 }, (err) => {
        if (err) anyFailed = true;
        pending--;
        if (pending === 0 && anyFailed !== lastInstallFailed) {
          if (anyFailed) app.log.warn('Failed to install one or more tmux hooks (tmux may not be running yet)');
          else if (lastInstallFailed !== null) app.log.info('tmux hooks installed successfully');
          lastInstallFailed = anyFailed;
        }
      });
    }
  };

  if (hasTmux) {
    installTmuxHooks();
    hookInstallInterval = setInterval(installTmuxHooks, 60000);
  } else {
    app.log.info(`tmux hooks not installed: no tmux on ${hostEnv.platform} hosts`);
  }
}

main().catch((err) => {
  reportFatal(`Fatal error starting agent: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
