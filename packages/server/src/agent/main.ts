import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { EventEmitter } from 'node:events';
import { execFile, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { resolveTmuxRuntime } from '../modules/servers/transport/TmuxRuntime';
import type { MuxRuntime } from '../modules/servers/Server';
import type { WebSocket } from 'ws';

import agentRoutes from './routes';
import { handleAgentTerminal } from '../modules/tmux/ws/agentTerminalHandler';
import { handleFileTail } from '../modules/files/ws/fileTailHandler';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { BrowserSessionManager } from '../modules/browser/BrowserSessionManager';
import { handleBrowserConnection } from '../modules/browser/ws/browserHandler';
import { handleDevtoolsRelay } from '../modules/browser/devtools';

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

  // Health endpoint (no auth) + tmux hook receiver + browser routes
  await app.register(agentRoutes, { agentVersion, startedAt, agentEventBus, browserSessionManager, bindAddress: BIND_ADDRESS });

  // Auth hook for all routes except /health and /api/hooks/tmux (localhost-only)
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) return;
    if (request.url.startsWith('/api/hooks/tmux')) return;
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // WebSocket routes
  await app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
      const url = new URL(request.url, 'http://localhost');
      const mode = url.searchParams.get('mode');

      if (mode === 'terminal') {
        const target = url.searchParams.get('target');
        const cols = parseInt(url.searchParams.get('cols') || '120', 10);
        const rows = parseInt(url.searchParams.get('rows') || '40', 10);
        if (!target) {
          socket.send(JSON.stringify({ error: 'target required' }));
          socket.close();
          return;
        }
        const muxParam = url.searchParams.get('mux');
        const mux = muxParam === 'system' || muxParam === 'managed' ? muxParam : undefined;
        handleAgentTerminal(socket, target, cols, rows, mux);
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
  const hookEvents = ['window-linked', 'window-unlinked', 'after-rename-window', 'after-kill-pane', 'session-window-changed', 'session-closed', 'after-select-pane'];

  const muxRuntime = (process.env.AZITO_MUX_RUNTIME as MuxRuntime) || 'system';
  const hookRt = resolveTmuxRuntime(muxRuntime, os.homedir());

  // Cleanup tmux hooks and browser on shutdown (must register before listen — Fastify rejects addHook after ready)
  let hookInstallInterval: ReturnType<typeof setInterval> | null = null;
  app.addHook('onClose', async () => {
    if (hookInstallInterval) {
      clearInterval(hookInstallInterval);
      hookInstallInterval = null;
    }
    await browserSessionManager.stopAll();
    for (const event of hookEvents) {
      await new Promise<void>((resolve) => {
        execFile(hookRt.bin, [...hookRt.baseArgs, 'set-hook', '-gu', `${event}[42]`], { timeout: 5000 }, () => resolve());
      });
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
  let lastInstallFailed: boolean | null = null;
  const installTmuxHooks = (): void => {
    let pending = hookEvents.length;
    let anyFailed = false;
    for (const event of hookEvents) {
      const hookValue = `run-shell "curl -sf -o /dev/null -X POST '${hookBase}?event=${event}&session=#{hook_session_name}' 2>/dev/null &"`;
      execFile(hookRt.bin, [...hookRt.baseArgs, 'set-hook', '-g', `${event}[42]`, hookValue], { timeout: 5000 }, (err) => {
        if (err) anyFailed = true;
        pending--;
        if (pending === 0 && anyFailed !== lastInstallFailed) {
          // Only log when the failure/success state changes, to avoid warn-spam every period
          // while tmux is not yet running.
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

main().catch((err) => {
  console.error('Fatal error starting agent:', err);
  process.exit(1);
});
