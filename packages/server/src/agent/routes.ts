import type { FastifyPluginCallback } from 'fastify';
import type { EventEmitter } from 'node:events';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { resolveTmuxRuntime } from '../modules/servers/transport/TmuxRuntime';
import type { MuxRuntime } from '../modules/servers/Server';
import { HOOK_EVENTS } from '../modules/tmux/tmuxHooks';

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.css': 'css', '.html': 'html',
  '.md': 'markdown', '.py': 'python',
  '.sh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'sql', '.toml': 'toml',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};

const BINARY_EXTS = new Set([
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.wasm', '.class', '.pyc',
]);

const MAX_FILE_SIZE = 500 * 1024;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

import type { BrowserSessionManager } from '../modules/browser/BrowserSessionManager';
import { openBrowserTab } from '../modules/browser/openBrowserTab';

export interface AgentRoutesOptions {
  agentVersion: string;
  startedAt: number;
  agentEventBus: EventEmitter;
  browserSessionManager: BrowserSessionManager;
  /**
   * Address this agent listens on. tmux hooks are registered against it (see
   * agent/main.ts), so requests the agent makes to itself arrive with this as
   * their source address, not a loopback one.
   */
  bindAddress: string;
}

function execCommand(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof raw === 'number' ? raw : 1) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
    });
  });
}

function execTmuxCommand(args: string[], timeoutMs: number, mux?: MuxRuntime): Promise<{ stdout: string; stderr: string; code: number }> {
  const rt = resolveTmuxRuntime(mux ?? (process.env.AZITO_MUX_RUNTIME as MuxRuntime) ?? 'system', os.homedir());
  return new Promise((resolve) => {
    execFile(rt.bin, [...rt.baseArgs, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof raw === 'number' ? raw : 1) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
    });
  });
}

const VALID_HOOK_EVENTS = new Set<string>(HOOK_EVENTS);

const agentRoutes: FastifyPluginCallback<AgentRoutesOptions> = (fastify, opts, done) => {
  const { agentVersion, startedAt, agentEventBus, browserSessionManager, bindAddress } = opts;

  // ── GET /health (no auth required — registered before auth hook) ──
  fastify.get('/health', async () => {
    return { version: agentVersion, uptime: Math.floor((Date.now() - startedAt) / 1000) };
  });

  // ── POST /api/exec ──
  // Arbitrary command execution endpoint — secured by token + Tailscale bind
  fastify.post('/api/exec', async (request) => {
    const { command, timeoutMs } = request.body as { command: string; timeoutMs?: number };
    return execCommand(command, timeoutMs ?? 15000);
  });

  // ── POST /api/tmux ──
  fastify.post('/api/tmux', async (request) => {
    const { args, timeoutMs, mux } = request.body as { args: string[]; timeoutMs?: number; mux?: MuxRuntime };
    return execTmuxCommand(args, timeoutMs ?? 15000, mux);
  });

  // ── GET /api/files ──
  fastify.get<{ Querystring: { path?: string; showHidden?: string } }>(
    '/api/files',
    async (request, reply) => {
      const dirPath = (request.query.path || '').trim();
      if (!dirPath) return reply.status(400).send({ error: 'path query parameter required' });
      const showHidden = request.query.showHidden === 'true';

      try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        const entries = items
          .filter((item) => showHidden || !item.name.startsWith('.'))
          .map((item) => {
            const fullPath = path.join(dirPath, item.name);
            const isDir = item.isDirectory();
            const entry: Record<string, unknown> = {
              name: item.name,
              type: isDir ? 'directory' : 'file',
              path: fullPath,
            };
            if (!isDir) {
              try { entry.size = fs.statSync(fullPath).size; } catch { /* ignore */ }
            }
            return entry;
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return (a.name as string).localeCompare(b.name as string);
          });
        return entries;
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/files/content ──
  fastify.get<{ Querystring: { path?: string } }>(
    '/api/files/content',
    async (request, reply) => {
      const filePath = (request.query.path || '').trim();
      if (!filePath) return reply.status(400).send({ error: 'path query parameter required' });

      const ext = path.extname(filePath).toLowerCase();

      if (IMAGE_EXTS.has(ext)) {
        const mimeType = IMAGE_MIME[ext] || 'application/octet-stream';
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_IMAGE_SIZE) {
            return reply.status(400).send({ error: `Image too large (${Math.round(stat.size / 1024)}KB). Maximum is 5MB.` });
          }
          const buf = fs.readFileSync(filePath);
          return { type: 'image', mimeType, base64: buf.toString('base64'), path: filePath, size: stat.size };
        } catch (err: unknown) {
          return reply.status(500).send({ error: (err as Error).message });
        }
      }

      if (BINARY_EXTS.has(ext)) {
        return reply.status(400).send({ error: 'Binary file cannot be displayed' });
      }

      const language = EXT_LANG[ext] || 'text';

      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          return reply.status(400).send({ error: `File too large (${Math.round(stat.size / 1024)}KB). Maximum is 500KB.` });
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('\0')) {
          return reply.status(400).send({ error: 'Binary file cannot be displayed' });
        }
        return { content, path: filePath, size: stat.size, language };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/directories ──
  fastify.get<{ Querystring: { path?: string } }>(
    '/api/directories',
    async (request) => {
      const inputPath = (request.query.path || '').trim();

      try {
        let dir: string;
        let prefix: string;

        if (inputPath.endsWith('/')) {
          dir = inputPath;
          prefix = '';
        } else {
          dir = path.dirname(inputPath);
          prefix = path.basename(inputPath).toLowerCase();
        }

        const items = fs.readdirSync(dir, { withFileTypes: true });
        return items
          .filter(item => item.isDirectory())
          .filter(item => !item.name.startsWith('.'))
          .filter(item => !prefix || item.name.toLowerCase().startsWith(prefix))
          .map(item => path.join(dir, item.name))
          .slice(0, 20);
      } catch {
        return [];
      }
    },
  );

  // ── GET /api/browser/targets ──
  fastify.get('/api/browser/targets', async (_request, reply) => {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      return await res.json();
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/browser/version ──
  fastify.get('/api/browser/version', async (_request, reply) => {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      return await res.json();
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/browser/page-target ──
  fastify.get<{ Querystring: { page?: string; group?: string } }>('/api/browser/page-target', async (request, reply) => {
    const rawPageId = request.query.page;
    const pageId = rawPageId && /^[A-Za-z0-9_-]{1,64}$/.test(rawPageId) ? rawPageId : 'default';
    const rawGroupId = request.query.group;
    const groupId = rawGroupId && /^[A-Za-z0-9_-]{1,64}$/.test(rawGroupId) ? rawGroupId : 'default';
    const status = browserSessionManager.getStatus('agent');
    if (!status.running) return reply.status(404).send({ error: 'Browser session not running' });
    const session = await browserSessionManager.getOrCreate('agent');
    const targetId = session.getPage(groupId, pageId)?.targetId ?? null;
    if (!targetId) return reply.status(404).send({ error: 'Page target not found' });
    return { targetId };
  });

  // ── GET /api/browser/status ──
  fastify.get('/api/browser/status', async () => {
    return browserSessionManager.getStatus('agent');
  });

  // ── POST /api/browser/open ──
  fastify.post<{ Body: { url?: string; holdSeconds?: number; taskId?: number; label?: string } }>('/api/browser/open', async (request) => {
    const { url, holdSeconds, taskId, label } = request.body ?? {};
    const result = await openBrowserTab(browserSessionManager, 'agent', { url, holdSeconds });
    agentEventBus.emit('browser-opened', {
      groupId: result.groupId,
      tabId: result.tabId,
      url: url ?? null,
      ...(typeof taskId === 'number' ? { taskId } : {}),
      ...(typeof label === 'string' ? { label } : {}),
    });
    return result;
  });

  // ── POST /api/browser/stop ──
  fastify.post('/api/browser/stop', async () => {
    await browserSessionManager.stop('agent');
    return { ok: true };
  });

  // ── POST /api/browser/keepalive ──
  fastify.post<{ Body: { groups?: unknown } }>('/api/browser/keepalive', async (request, reply) => {
    const { groups } = request.body ?? {};
    if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(g))) {
      return reply.status(400).send({ error: 'invalid groups' });
    }
    browserSessionManager.keepalive('agent', groups);
    return { ok: true };
  });

  // ── POST /api/browser/close-group ──
  fastify.post<{ Body: { group?: string } }>('/api/browser/close-group', async (request, reply) => {
    const { group } = request.body ?? {};
    if (!group || !/^[A-Za-z0-9_-]{1,64}$/.test(group)) {
      return reply.status(400).send({ error: 'group required' });
    }
    await browserSessionManager.closeGroup('agent', group);
    return { ok: true };
  });

  // ── POST /api/hooks/tmux (no auth — called by local tmux set-hook via curl) ──
  fastify.post('/api/hooks/tmux', async (request, reply) => {
    // Same-host only. The agent binds to a routable address (a Tailscale IP —
    // 0.0.0.0 is rejected at startup) so the hub can reach it, and registers its
    // tmux hooks against that same address. Traffic the host sends to its own
    // address therefore arrives with that address as its source, never a
    // loopback one, so accepting only loopback silently rejected every hook the
    // agent had itself installed. Peers on the tailnet still carry their own
    // source address and remain rejected.
    const remoteIp = request.ip;
    const sameHost =
      remoteIp === '127.0.0.1' ||
      remoteIp === '::1' ||
      remoteIp === '::ffff:127.0.0.1' ||
      remoteIp === bindAddress ||
      remoteIp === `::ffff:${bindAddress}`;
    if (!sameHost) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const { event, session } = request.query as { event?: string; session?: string };
    if (!event || !VALID_HOOK_EVENTS.has(event)) {
      return reply.status(400).send({ error: 'invalid event' });
    }
    if (session && session.startsWith('_azito_') && event !== 'after-select-pane') {
      return { ok: true, ignored: true };
    }
    agentEventBus.emit('tmux-event', { event });
    return { ok: true };
  });

  done();
};

export default agentRoutes;
