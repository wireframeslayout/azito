import type { FastifyPluginCallback } from 'fastify';
import type { BrowserSessionManager } from './BrowserSessionManager';
import type { SqliteServerRepository } from '../servers/SqliteServerRepository';
import type { ServerConfig } from '../servers/Server';
import { openBrowserTab } from './openBrowserTab';

export interface BrowserOpenedPayload {
  serverName: string;
  groupId: string;
  tabId: string;
  url: string | null;
  taskId?: number;
  label?: string;
}

export interface BrowserRouteOptions {
  browserSessionManager: BrowserSessionManager;
  serverRepo: SqliteServerRepository;
  onTabOpened?: (payload: BrowserOpenedPayload) => void;
}

const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fetchAgent(srv: ServerConfig, path: string, body: unknown): Promise<Response> {
  const authHeader = srv.agentToken ? `Bearer ${srv.agentToken}` : undefined;
  return fetch(`http://${srv.host}:${srv.agentPort}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function proxyToAgent(srv: ServerConfig, path: string, body: unknown): Promise<void> {
  if (!srv.host || !srv.agentPort) return;
  try {
    await fetchAgent(srv, path, body);
  } catch {
    // Best-effort: keepalive/close-group are fire-and-forget.
  }
}

const browserRoutes: FastifyPluginCallback<BrowserRouteOptions> = (fastify, opts, done) => {
  const { browserSessionManager, serverRepo } = opts;

  fastify.get<{ Querystring: { server?: string } }>('/api/browser/status', async (request, reply) => {
    const serverName = request.query.server;
    if (!serverName) return reply.status(400).send({ error: 'server query parameter required' });
    return browserSessionManager.getStatus(serverName);
  });

  fastify.post<{ Querystring: { server?: string } }>('/api/browser/stop', async (request, reply) => {
    const serverName = request.query.server;
    if (!serverName) return reply.status(400).send({ error: 'server query parameter required' });
    await browserSessionManager.stop(serverName);
    return { ok: true };
  });

  fastify.post<{ Body: { server?: string; groups?: unknown } }>('/api/browser/keepalive', async (request, reply) => {
    const { server, groups } = request.body ?? {};
    if (!server) return reply.status(400).send({ error: 'server required' });
    if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || !GROUP_ID_RE.test(g))) {
      return reply.status(400).send({ error: 'invalid groups' });
    }

    const srv = serverRepo.findByName(server);
    if (srv?.type === 'agent') {
      await proxyToAgent(srv, '/api/browser/keepalive', { groups });
      return { ok: true };
    }
    browserSessionManager.keepalive(server, groups);
    return { ok: true };
  });

  fastify.post<{ Body: { server?: string; url?: string; holdSeconds?: number; taskId?: number; label?: string } }>('/api/browser/open', async (request, reply) => {
    const { server: serverName, url, holdSeconds, taskId, label } = request.body ?? {} as Record<string, unknown>;
    if (!serverName || typeof serverName !== 'string') {
      return reply.status(400).send({ error: 'server is required' });
    }

    const srv = serverRepo.findByName(serverName);
    if (!srv) {
      return reply.status(404).send({ error: `Server not found: ${serverName}` });
    }
    if (srv.type === 'agent') {
      if (!srv.host || !srv.agentPort) {
        return reply.status(400).send({ error: 'agent server not configured' });
      }
      const res = await fetchAgent(srv, '/api/browser/open', { url, holdSeconds });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'agent request failed' }));
        return reply.status(res.status).send(err);
      }
      // Agent path: notification is relayed via AgentEventStream (browser-opened WS event),
      // so do NOT call onTabOpened here — that would cause a duplicate browser:opened emission.
      return res.json();
    }

    const hubOrigin = `${request.protocol}://${request.hostname}`;
    const result = await openBrowserTab(browserSessionManager, serverName, { url, holdSeconds, hubOrigin });
    const validTaskId = typeof taskId === 'number' ? taskId : undefined;
    const validLabel = typeof label === 'string' ? label : undefined;
    opts.onTabOpened?.({ serverName, groupId: result.groupId, tabId: result.tabId, url: url ?? null, taskId: validTaskId, label: validLabel });
    return result;
  });

  fastify.post<{ Body: { server?: string; group?: string } }>('/api/browser/close-group', async (request, reply) => {
    const { server, group } = request.body ?? {};
    if (!server || !group || !GROUP_ID_RE.test(group)) {
      return reply.status(400).send({ error: 'server and group required' });
    }

    const srv = serverRepo.findByName(server);
    if (srv?.type === 'agent') {
      await proxyToAgent(srv, '/api/browser/close-group', { group });
      return { ok: true };
    }
    await browserSessionManager.closeGroup(server, group);
    return { ok: true };
  });

  done();
};

export default browserRoutes;
