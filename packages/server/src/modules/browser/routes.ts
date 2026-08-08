import type { FastifyPluginCallback } from 'fastify';
import type { BrowserSessionManager } from './BrowserSessionManager';
import type { SqliteServerRepository } from '../servers/SqliteServerRepository';
import type { ServerConfig } from '../servers/Server';
import { openBrowserTab } from './openBrowserTab';
import type { SqliteBrowserGroupRepository } from './SqliteBrowserGroupRepository';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { recordAuditBestEffort } from '../../shared/audit/recordAuditBestEffort';
import type { RouteAuthRequirement } from '../../shared/auth/routeAuth';

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
  /**
   * Task-owned browser group registry (Issue #28 Phase E, design v3 §11).
   * `POST /api/browser/open` records `(groupId, serverName, taskId)` here on
   * every successful open; `POST /api/browser/close-group` reads it back to
   * confirm a task principal only ever closes a group it opened itself.
   */
  browserGroupRepo: SqliteBrowserGroupRepository;
  /** Best-effort audit trail for a task-principal call denied by group ownership (see `browserGroupRepo` above) — mirrors every other in-handler ownership denial in this codebase (`recordAuditBestEffort`'s own doc comment). */
  auditLogService?: AuditLogService;
  onTabOpened?: (payload: BrowserOpenedPayload) => void;
}

const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `POST /api/browser/open`: a task principal may always open a NEW group —
 * there is nothing pre-existing to check ownership against, so the class
 * gate alone is the whole requirement (Issue #28 Phase E, design v3 §11).
 * The route handler itself forces the recorded owner to `principal.id`
 * whenever the caller is a task (never trusting a client-supplied `taskId`
 * in the body for that), and strips `cdpEndpoint` from a task principal's
 * response — see the route body below.
 */
export const browserOpenAuth: RouteAuthRequirement = {
  classes: ['task'],
  operation: 'browser.open',
};

/**
 * `POST /api/browser/close-group`: no `condition` here (unlike
 * `tasks.routes.ts`'s `taskSelfAuth`/`childrenAuth`) because `group` lives
 * in the POST body, and `buildServer.ts`'s auth hook runs on `onRequest` —
 * BEFORE Fastify parses the body (Issue #28 Phase E investigation finding:
 * every existing `condition` function reads only `request.params`/
 * `request.query`, never `request.body`, for exactly this reason). The
 * class gate lets any task principal reach the handler; ownership is then
 * checked in-handler against `browserGroupRepo` once the body IS parsed —
 * the same "class-gate only, narrow inside the handler" shape
 * `sidekickListAuth` already uses for `GET /api/sidekicks` (see that route's
 * own doc comment).
 */
export const browserCloseGroupAuth: RouteAuthRequirement = {
  classes: ['task'],
  operation: 'browser.close_group',
};

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

/**
 * Strips `cdpEndpoint` from a `POST /api/browser/open` response before it
 * reaches a task principal (Issue #28 Phase E, design v3 §11: "CDP エンド
 * ポイントの直接引き渡しをタスク主体には行わない"). `cdpEndpoint` is a raw,
 * unauthenticated CDP endpoint on the server's localhost — connecting to it
 * grants control of every group/tab the shared browser process holds, not
 * just the one this call opened, so it must never reach a task. An operator
 * caller (browser panel UI) still needs it — untouched here.
 */
function redactCdpEndpointForTask(body: Record<string, unknown>, isTaskPrincipal: boolean): Record<string, unknown> {
  if (!isTaskPrincipal || !('cdpEndpoint' in body)) return body;
  const { cdpEndpoint: _cdpEndpoint, ...rest } = body;
  return rest;
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

  fastify.post<{ Body: { server?: string; url?: string; holdSeconds?: number; taskId?: number; label?: string } }>(
    '/api/browser/open',
    { config: { auth: browserOpenAuth } },
    async (request, reply) => {
      const { server: serverName, url, holdSeconds, taskId, label } = request.body ?? {} as Record<string, unknown>;
      if (!serverName || typeof serverName !== 'string') {
        return reply.status(400).send({ error: 'server is required' });
      }

      // Issue #28 Phase E (design v3 §11): a task principal owns whatever
      // group it opens — always its OWN task id, regardless of what (if
      // anything) the body's `taskId` claims. An operator's `taskId` is
      // trusted as-is (metadata only, see `onTabOpened` below — unchanged
      // from before this fix).
      const principal = request.principal;
      const isTaskPrincipal = principal?.class === 'task' && typeof principal.id === 'number';
      const ownerTaskId = isTaskPrincipal
        ? (principal.id as number)
        : (typeof taskId === 'number' ? taskId : null);

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
        const body = await res.json() as Record<string, unknown>;
        if (typeof body.groupId === 'string') {
          opts.browserGroupRepo.recordOwner(serverName, body.groupId, ownerTaskId);
        }
        // Agent path: notification is relayed via AgentEventStream (browser-opened WS event),
        // so do NOT call onTabOpened here — that would cause a duplicate browser:opened emission.
        return redactCdpEndpointForTask(body, isTaskPrincipal);
      }

      const hubOrigin = `${request.protocol}://${request.hostname}`;
      const result = await openBrowserTab(browserSessionManager, serverName, { url, holdSeconds, hubOrigin });
      opts.browserGroupRepo.recordOwner(serverName, result.groupId, ownerTaskId);
      const validLabel = typeof label === 'string' ? label : undefined;
      opts.onTabOpened?.({ serverName, groupId: result.groupId, tabId: result.tabId, url: url ?? null, taskId: ownerTaskId ?? undefined, label: validLabel });
      return redactCdpEndpointForTask(result as unknown as Record<string, unknown>, isTaskPrincipal);
    },
  );

  fastify.post<{ Body: { server?: string; group?: string } }>(
    '/api/browser/close-group',
    { config: { auth: browserCloseGroupAuth } },
    async (request, reply) => {
      const { server, group } = request.body ?? {};
      if (!server || !group || !GROUP_ID_RE.test(group)) {
        return reply.status(400).send({ error: 'server and group required' });
      }

      // Issue #28 Phase E (design v3 §11): ownership enforced HERE, not via
      // `condition` on `browserCloseGroupAuth` — see that requirement's own
      // doc comment for why (`group` is body-only, unavailable at the
      // onRequest stage the generic auth hook runs at).
      if (request.principal?.class === 'task') {
        const ownerTaskId = opts.browserGroupRepo.findOwnerTaskId(server, group);
        if (ownerTaskId !== request.principal.id) {
          recordAuditBestEffort(opts.auditLogService, {
            actorClass: 'task',
            actorId: request.principal.id ?? null,
            event: 'browser.close_group.denied',
            detail: { serverName: server, groupId: group },
          });
          return reply.status(403).send({ error: 'operator_required', operation: 'browser.close_group' });
        }
      }

      const srv = serverRepo.findByName(server);
      if (srv?.type === 'agent') {
        await proxyToAgent(srv, '/api/browser/close-group', { group });
      } else {
        await browserSessionManager.closeGroup(server, group);
      }
      opts.browserGroupRepo.remove(server, group);
      return { ok: true };
    },
  );

  done();
};

export default browserRoutes;
