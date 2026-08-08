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
    // Best-effort: keepalive is fire-and-forget. `close-group` no longer
    // uses this helper — see `closeGroupOnAgent` below.
  }
}

/**
 * Confirms the remote agent's `close-group` actually succeeded (or the
 * group was already gone) before the caller drops this hub's own ownership
 * row (Issue #28 review fix 2). `proxyToAgent` above is deliberately
 * fire-and-forget for best-effort calls like keepalive — `close-group` is
 * NOT best-effort: swallowing a network failure or an unchecked non-2xx
 * response here, then unconditionally deleting the `browser_groups` row
 * anyway (the original bug), leaves the remote group alive while this hub
 * forgets who owns it. The owning task's token then fails EVERY future
 * close-group attempt with `operator_required` forever (`findOwnerTaskId`
 * returns `undefined` once the row is gone, never matching that task's
 * principal id again) even though the remote session is still there and
 * still closeable.
 *
 * The agent's own `POST /api/browser/close-group` handler
 * (`agent/routes.ts`) is already idempotent — it replies 200 even when the
 * session/group doesn't exist on that agent at all (`BrowserSessionManager.
 * closeGroup` no-ops when there is no live session) — so "already gone" is
 * indistinguishable from "just closed" here, and both are success. Only a
 * network failure or a genuine non-2xx response counts as failure.
 */
async function closeGroupOnAgent(srv: ServerConfig, group: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!srv.host || !srv.agentPort) {
    return { ok: false, message: 'agent server not configured' };
  }
  try {
    const res = await fetchAgent(srv, '/api/browser/close-group', { group });
    if (!res.ok) {
      return { ok: false, message: `agent close-group request failed with status ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'agent close-group request failed' };
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

      // Issue #28 Phase E (design v3 §11), review fix 1: ownership is
      // derived ONLY from the authenticated `request.principal`, never from
      // client-supplied body metadata. The original shape let an operator's
      // body `taskId` become `ownerTaskId` directly — unverified metadata on
      // an operator's call was enough to grant that task's own token close
      // authority over a group it never opened. A task principal always owns
      // whatever it opens (its own id); every other caller's open is
      // unowned (`null`), full stop — a body `taskId` is never trusted for
      // authorization.
      const principal = request.principal;
      const isTaskPrincipal = principal?.class === 'task' && typeof principal.id === 'number';
      const ownerTaskId = isTaskPrincipal ? (principal.id as number) : null;
      // Notification-only metadata — kept as a separate variable from
      // `ownerTaskId` above so it can never accidentally flow into an
      // authorization decision. An operator's client-supplied `taskId` is
      // still useful context for the `browser:opened` event/UI (it always
      // was, before this fix), it just no longer grants ownership.
      const notifyTaskId = isTaskPrincipal
        ? (principal.id as number)
        : (typeof taskId === 'number' ? taskId : undefined);

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
      opts.onTabOpened?.({ serverName, groupId: result.groupId, tabId: result.tabId, url: url ?? null, taskId: notifyTaskId, label: validLabel });
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
        // Issue #28 review fix 2: ownership is only dropped once the agent
        // confirms the group is actually gone (or already was) — see
        // `closeGroupOnAgent`'s doc comment for why a swallowed failure
        // here must never reach the `remove()` call below.
        const result = await closeGroupOnAgent(srv, group);
        if (!result.ok) {
          return reply.status(502).send({ error: 'agent_close_group_failed', message: result.message });
        }
      } else {
        // Local path: `browserSessionManager.closeGroup` throws on a
        // genuine failure, which Fastify's default error handler turns
        // into a 500 before execution ever reaches `remove()` below — so
        // the same "never drop ownership on failure" guarantee already
        // holds here without extra plumbing.
        await browserSessionManager.closeGroup(server, group);
      }
      opts.browserGroupRepo.remove(server, group);
      return { ok: true };
    },
  );

  done();
};

export default browserRoutes;
