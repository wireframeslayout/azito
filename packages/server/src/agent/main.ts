import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { EventEmitter } from 'node:events';
import { execFile, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { resolveTmuxRuntime } from '../modules/servers/transport/TmuxRuntime';
import { LocalTransport } from '../modules/servers/transport/LocalTransport';
import { HerdrSocketClient } from '../modules/mux/herdr/HerdrSocketClient';
import type { MuxRuntime } from '../modules/servers/Server';
import type { WebSocket } from 'ws';

import agentRoutes from './routes';
import { handleAgentTerminal } from '../modules/tmux/ws/agentTerminalHandler';
import { muxRefFromTmuxTarget, parseMuxRef, muxKindForRuntime, type MuxRef, type PaneOrdinal } from '@azito/shared';
import { HOOK_EVENTS, buildHookValue, buildHookSetArgs, buildHookUnsetArgs } from '../modules/tmux/tmuxHooks';
import { handleFileTail } from '../modules/files/ws/fileTailHandler';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { BrowserSessionManager } from '../modules/browser/BrowserSessionManager';
import { handleBrowserConnection } from '../modules/browser/ws/browserHandler';
import { handleDevtoolsRelay } from '../modules/browser/devtools';
import { ensureHerdrClientConfigs } from '../modules/mux/herdr/herdrClientConfig';
import { HerdrEventSubscriber, type HerdrEvent, type HerdrSubscription } from '../modules/mux/herdr/HerdrEventSubscriber';
import { herdrSocketPath } from '../modules/mux/herdr/HerdrSocketClient';
import { ZellijResidentClient } from '../modules/mux/zellij/ZellijResidentClient';

/** `session.snapshot` arrives as `{ id, result: { type, snapshot } }` (or, from tests, already unwrapped). */
function unwrapHerdrSnapshot(resp: unknown): unknown {
  const env = (resp && typeof resp === 'object' && 'result' in (resp as Record<string, unknown>)) ? (resp as { result: unknown }).result : resp;
  if (env && typeof env === 'object' && 'snapshot' in (env as Record<string, unknown>)) return (env as { snapshot: unknown }).snapshot;
  return env;
}


// ─── Environment validation ───

const bind = process.env.AZITO_AGENT_BIND;
if (!bind) {
  console.error('AZITO_AGENT_BIND is required');
  process.exit(1);
}
if (bind === '0.0.0.0') {
  console.error('AZITO_AGENT_BIND must not be 0.0.0.0 — bind to a Tailscale IP instead');
  process.exit(1);
}
/** Same value as `bind`, restated so its non-undefined type survives into main(). */
const BIND_ADDRESS: string = bind;

const token = process.env.AZITO_AGENT_TOKEN;
if (!token) {
  console.error('AZITO_AGENT_TOKEN is required');
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
      return execSync('git rev-parse --short HEAD', { timeout: 3000 }).toString().trim();
    } catch { return 'unknown'; }
  }
}
const agentVersion = resolveVersion();

// ─── Graceful shutdown ───

const SHUTDOWN_HARD_CAP_MS = 8000;

// ─── Bootstrap ───

async function main(): Promise<void> {
  const startedAt = Date.now();
  const app = Fastify({ logger: true });
  const agentEventBus = new EventEmitter();
  const browserSessionManager = new BrowserSessionManager(
    path.resolve(os.homedir(), '.azito', 'browser-profile'),
  );

  await app.register(websocket);

  const zellijResident = new ZellijResidentClient();

  // Health endpoint (no auth) + tmux hook receiver + browser routes
  await app.register(agentRoutes, {
    agentVersion, startedAt, agentEventBus, browserSessionManager, bindAddress: BIND_ADDRESS,
    onHerdrMuxRequest: () => startHerdrRelay(),
    zellijResident,
  });

  // Auth hook for all routes except /health and /api/hooks/tmux (localhost-only)
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) return;
    if (request.url.startsWith('/api/hooks/tmux')) return;
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  const muxRuntime = (process.env.AZITO_MUX_RUNTIME as MuxRuntime) || 'system';
  const muxKind = muxKindForRuntime(muxRuntime);
  const isTmuxDriver = muxKind === 'tmux';
  const hookRt = isTmuxDriver ? resolveTmuxRuntime(muxRuntime, os.homedir()) : null;
  const transportRt = hookRt ?? resolveTmuxRuntime('system', os.homedir());

  // Build herdr socket for LocalTransport when running under herdr
  const herdrSession = process.env.HERDR_SESSION || 'azito';
  const herdrSocket = muxKind === 'herdr'
    ? new HerdrSocketClient(herdrSession)
    : undefined;

  const agentTransport = new LocalTransport(transportRt, process.env.AZITO_URL ?? '', herdrSocket);

  ensureHerdrClientConfigs();

  // herdr event relay: detect herdr socket presence (regardless of AZITO_MUX_RUNTIME)
  // and subscribe to structural + agent_status events, relaying them to the hub
  // as `mux-event` WS messages. Polls for the socket every 30s if not found initially.
  let herdrSubscriber: HerdrEventSubscriber | undefined;
  let herdrProbeTimer: ReturnType<typeof setInterval> | null = null;
  const herdrSockPath = herdrSocketPath(herdrSession);
  const herdrRelayPaneCache = new Map<string, { workspace_label: string }>();
  const herdrRelayWsCache = new Map<string, string>();
  let herdrRelaySocket: HerdrSocketClient | undefined;

  function startHerdrRelay(): boolean {
    if (herdrSubscriber) return false;
    if (!fs.existsSync(herdrSockPath)) return false;
    herdrRelaySocket = new HerdrSocketClient(herdrSession);
    const subs: HerdrSubscription[] = [
      { type: 'tab.created' },
      { type: 'tab.closed' },
      { type: 'tab.renamed' },
      { type: 'workspace.created' },
      { type: 'workspace.closed' },
      { type: 'workspace.renamed' },
      { type: 'pane.created' },
      { type: 'pane.closed' },
      { type: 'workspace.focused' },
    ];
    const rebuildPaneCache = async (): Promise<void> => {
      try {
        const resp = await herdrRelaySocket!.call('session.snapshot');
        const snap = unwrapHerdrSnapshot(resp) as {
          panes: Array<{ pane_id: string; workspace_id: string; tab_id: string }>;
          workspaces: Array<{ workspace_id: string; label: string }>;
          tabs: Array<{ tab_id: string; label: string }>;
        };
        herdrRelayPaneCache.clear();
        herdrRelayWsCache.clear();
        const wsLabels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]));
        for (const [id, label] of wsLabels) herdrRelayWsCache.set(id, label);
        const paneIds: string[] = [];
        for (const p of snap.panes) {
          const wl = wsLabels.get(p.workspace_id);
          if (wl) {
            herdrRelayPaneCache.set(p.pane_id, { workspace_label: wl });
            paneIds.push(p.pane_id);
          }
        }
        if (paneIds.length > 0) {
          herdrSubscriber!.addSubscriptions(
            paneIds.map(id => ({ type: 'pane.agent_status_changed', pane_id: id })),
          );
        }
      } catch (err) {
        console.error('[agent-herdr] Failed to rebuild pane cache:', (err as Error).message);
      }
    };
    herdrSubscriber = new HerdrEventSubscriber(herdrSockPath, subs);
    herdrSubscriber.on('connected', () => void rebuildPaneCache());
    herdrSubscriber.on('event', (event: HerdrEvent) => {
      if (event.type === 'pane.agent_status_changed') {
        const paneId = event.pane_id as string | undefined;
        if (!paneId) return;
        const mapping = herdrRelayPaneCache.get(paneId);
        if (!mapping) return;
        agentEventBus.emit('mux-event', { ...event, workspace_label: mapping.workspace_label, tab_label: 'main' });
        return;
      }
      if (event.type === 'workspace.focused') {
        const wsId = event.workspace_id as string | undefined;
        if (!wsId) return;
        const label = herdrRelayWsCache.get(wsId);
        if (!label) return;
        agentEventBus.emit('mux-event', { ...event, workspace_label: label });
        return;
      }
      agentEventBus.emit('mux-event', event);
      agentEventBus.emit('tmux-event', { event: event.type });
      if (event.type === 'pane.created' && event.pane_id) {
        herdrSubscriber!.addSubscriptions([{
          type: 'pane.agent_status_changed',
          pane_id: event.pane_id as string,
        }]);
        void (async () => {
          try {
            const r = await herdrRelaySocket!.call('session.snapshot');
            const s = unwrapHerdrSnapshot(r) as {
              panes: Array<{ pane_id: string; workspace_id: string; tab_id: string }>;
              workspaces: Array<{ workspace_id: string; label: string }>;
            };
            const pane = s.panes.find(p => p.pane_id === event.pane_id);
            if (!pane) return;
            const wl = s.workspaces.find(w => w.workspace_id === pane.workspace_id)?.label;
            if (wl) herdrRelayPaneCache.set(event.pane_id as string, { workspace_label: wl });
          } catch { /* non-fatal */ }
        })();
      }
      if (event.type !== 'pane.created' && event.type !== 'pane.closed') {
        void rebuildPaneCache();
      } else if (event.type === 'pane.closed' && event.pane_id) {
        herdrRelayPaneCache.delete(event.pane_id as string);
      }
    });
    herdrSubscriber.start();
    console.log(`[agent-herdr] Relay started (socket: ${herdrSockPath})`);
    return true;
  }

  // Try at startup, then probe every 30s if not found.
  if (!startHerdrRelay()) {
    herdrProbeTimer = setInterval(() => {
      if (startHerdrRelay() && herdrProbeTimer) {
        clearInterval(herdrProbeTimer);
        herdrProbeTimer = null;
      }
    }, 30_000);
  }

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
        const herdrLockParam = url.searchParams.get('herdrLock');
        const terminalOpts = herdrLockParam === 'locked' || herdrLockParam === 'free' ? { herdrLock: herdrLockParam as 'locked' | 'free' } : undefined;

        handleAgentTerminal(socket, ref, ordinal, cols, rows, agentTransport, terminalOpts);
        return;
      }

      if (mode === 'file-tail') {
        const filePath = url.searchParams.get('path');
        if (!filePath) {
          socket.send(JSON.stringify({ error: 'path required' }));
          socket.close();
          return;
        }
        handleFileTail(socket, filePath);
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
        const onMuxEvent = (data: HerdrEvent) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'mux-event', data }));
          }
        };
        const onBrowserOpened = (data: { groupId: string; tabId: string; url: string | null; taskId?: number; label?: string }) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'browser-opened', groupId: data.groupId, tabId: data.tabId, url: data.url, taskId: data.taskId, label: data.label }));
          }
        };
        agentEventBus.on('tmux-event', onTmuxEvent);
        agentEventBus.on('mux-event', onMuxEvent);
        agentEventBus.on('browser-opened', onBrowserOpened);
        socket.on('close', () => {
          agentEventBus.off('tmux-event', onTmuxEvent);
          agentEventBus.off('mux-event', onMuxEvent);
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
    zellijResident.detachAll();
    if (herdrProbeTimer) { clearInterval(herdrProbeTimer); herdrProbeTimer = null; }
    herdrSubscriber?.stop();
    if (hookRt) {
      for (const event of hookEvents) {
        await new Promise<void>((resolve) => {
          execFile(hookRt.bin, [...hookRt.baseArgs, ...buildHookUnsetArgs(event)], { timeout: 5000 }, () => resolve());
        });
      }
    }
  });

  await app.listen({ port: PORT, host: bind });

  // Graceful shutdown: app.close() runs the onClose hook above (browserSessionManager.stopAll +
  // tmux hook cleanup + interval clear), then exits. A hard cap forces exit if close() hangs
  // (e.g. a stuck Chromium process), and a running flag ignores a second signal during shutdown.
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

  // Install tmux hooks to notify on window/pane changes. `set-hook -g` is idempotent, so this is
  // re-run periodically to survive a tmux server that starts/restarts after the agent (in which case
  // the initial install fails because tmux isn't up yet, and the next periodic pass installs it).
  // Skipped entirely for non-tmux drivers.
  if (hookRt) {
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

    installTmuxHooks();
    hookInstallInterval = setInterval(installTmuxHooks, 60000);
  }
}

main().catch((err) => {
  console.error('Fatal error starting agent:', err);
  process.exit(1);
});
