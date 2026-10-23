import type { FastifyPluginCallback } from 'fastify';
import type { EventEmitter } from 'node:events';
import { execFile } from 'child_process';
import { resolveTmuxRuntime } from '../modules/servers/transport/TmuxRuntime';
import type { MuxRuntime } from '../modules/servers/Server';
import { HOOK_EVENTS } from '../modules/tmux/tmuxHooks';
import { HostProfileError, assertPosixHost, type HostProfile } from '../shared/os/hostProfile';
import { commandSpecSchema } from '../shared/exec/commandSpec';
import { AGENT_RUN_PATH, runToResponse } from '../shared/exec/runWire';
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
  /** The agent's home directory, resolved once at startup (HostEnv). */
  homeDir: string;
  /** The OS / architecture of this agent's host, resolved once at startup. */
  hostProfile: HostProfile;
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

let runtimeMismatchWarned = false;

function execTmuxCommand(args: string[], timeoutMs: number, homeDir: string, mux?: MuxRuntime): Promise<{ stdout: string; stderr: string; code: number }> {
  let rt: ReturnType<typeof resolveTmuxRuntime>;
  try {
    rt = resolveTmuxRuntime(mux ?? (process.env.AZITO_MUX_RUNTIME as MuxRuntime) ?? 'system', homeDir);
  } catch (err) {
    if (!runtimeMismatchWarned) {
      runtimeMismatchWarned = true;
      console.warn(`[agent] ${(err as Error).message} — rejecting tmux mux request`);
    }
    return Promise.reject({ statusCode: 409, message: (err as Error).message });
  }
  return new Promise((resolve) => {
    execFile(rt.bin, [...rt.baseArgs, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof raw === 'number' ? raw : 1) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
    });
  });
}

function execMuxCommand(req: { kind: string; args?: string[]; method?: string; params?: unknown }, timeoutMs: number, homeDir: string, mux?: MuxRuntime): Promise<{ stdout: string; stderr: string; code: number }> {
  if (req.kind === 'tmux') {
    return execTmuxCommand(req.args ?? [], timeoutMs, homeDir, mux);
  }
  return Promise.reject({ statusCode: 501, message: `Mux kind "${req.kind}" not implemented on this agent` });
}

const VALID_HOOK_EVENTS = new Set<string>(HOOK_EVENTS);

const agentRoutes: FastifyPluginCallback<AgentRoutesOptions> = (fastify, opts, done) => {
  const { agentVersion, startedAt, agentEventBus, browserSessionManager, bindAddress, homeDir, hostProfile } = opts;

  // ── GET /health (no auth required — registered before auth hook) ──
  fastify.get('/health', async () => {
    return { version: agentVersion, uptime: Math.floor((Date.now() - startedAt) / 1000) };
  });

  // ── POST /api/exec ──
  // Arbitrary command execution endpoint — secured by token + Tailscale bind
  fastify.post('/api/exec', async (request, reply) => {
    const { command, timeoutMs } = request.body as { command: string; timeoutMs?: number };
    // The command is run with /bin/sh: a Windows agent has none, so it says so instead of failing to spawn.
    try {
      assertPosixHost(hostProfile, 'this agent');
    } catch (err) {
      if (err instanceof HostProfileError) return reply.status(501).send({ error: err.code, message: err.message });
      throw err;
    }
    return execCommand(command, timeoutMs ?? 15000);
  });

  // ── POST /api/run ──
  // Runs one program with its arguments, with no shell, on any OS — the same function the hub runs a local server's commands with.
  // The body is untrusted input: it is validated here, the boundary. Secured by the token like every /api route.
  fastify.post(AGENT_RUN_PATH, async (request, reply) => {
    const parsed = commandSpecSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_command_spec', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    return runToResponse(parsed.data, { windows: hostProfile.platform === 'win32' });
  });

  // ── POST /api/tmux (compatibility wrapper) ──
  fastify.post('/api/tmux', async (request) => {
    const { args, timeoutMs, mux } = request.body as { args: string[]; timeoutMs?: number; mux?: MuxRuntime };
    return execMuxCommand({ kind: 'tmux', args }, timeoutMs ?? 15000, homeDir, mux);
  });

  // ── POST /api/mux ──
  fastify.post('/api/mux', async (request, reply) => {
    const req = request.body as { kind: string; args?: string[]; method?: string; params?: unknown; timeoutMs?: number; action?: string; session?: string; mux?: MuxRuntime };

    const { timeoutMs, action: _a, session: _s, mux, ...muxReq } = req;
    try {
      return await execMuxCommand(muxReq, timeoutMs ?? 15000, homeDir, mux);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const e = err as Record<string, unknown>;
        return reply.status(e.statusCode as number).send({ error: String(e.message ?? '') });
      }
      throw err;
    }
  });

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
