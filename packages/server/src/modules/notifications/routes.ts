import type { FastifyPluginCallback } from 'fastify';
import type { SqlitePushSubscriptionRepository } from './SqlitePushSubscriptionRepository';
import type { SqliteAgentWatchRepository } from './SqliteAgentWatchRepository';
import type { PushNotificationService } from './push/PushNotificationService';
import type { VapidKeys } from './push/VapidKeyManager';
import { getPushMessage } from './push/pushCatalog';
import { stripPaneSuffix } from '@azito/shared';

const ALLOWED_PUSH_HOSTS = [
  /\.googleapis\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /\.push\.apple\.com$/,
];

function validatePushEndpoint(endpoint: string): string | null {
  let url: URL;
  try { url = new URL(endpoint); } catch { return 'Invalid endpoint URL'; }
  if (url.protocol !== 'https:') return 'endpoint must be https';
  if (!ALLOWED_PUSH_HOSTS.some((re) => re.test(url.hostname))) return 'Unsupported push service host';
  return null;
}

export interface NotificationRouteOptions {
  pushSubRepo: SqlitePushSubscriptionRepository;
  pushService: PushNotificationService;
  vapidKeys: VapidKeys;
  agentWatchRepo: SqliteAgentWatchRepository;
}

const notificationRoutes: FastifyPluginCallback<NotificationRouteOptions> = (fastify, opts, done) => {
  const { pushSubRepo, pushService, vapidKeys, agentWatchRepo } = opts;

  // GET /api/notifications/vapid-public-key
  fastify.get('/api/notifications/vapid-public-key', async () => {
    return { publicKey: vapidKeys.publicKey };
  });

  // POST /api/notifications/subscribe
  fastify.post('/api/notifications/subscribe', async (request, reply) => {
    const body = request.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      lang?: string;
    };

    const endpoint = body.endpoint;
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;

    if (!endpoint || !p256dh || !auth) {
      return reply.status(400).send({ error: 'Invalid subscription: endpoint, keys.p256dh, keys.auth required' });
    }

    const endpointErr = validatePushEndpoint(endpoint);
    if (endpointErr) return reply.status(400).send({ error: endpointErr });
    if (p256dh.length > 200 || auth.length > 100) return reply.status(400).send({ error: 'Invalid key length' });
    const lang = body.lang === 'ja' ? 'ja' : 'en';

    try {
      pushSubRepo.create(endpoint, p256dh, auth, lang);
      return { ok: true };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // DELETE /api/notifications/unsubscribe
  fastify.delete('/api/notifications/unsubscribe', async (request, reply) => {
    const { endpoint } = request.body as { endpoint?: string };
    if (!endpoint) {
      return reply.status(400).send({ error: 'endpoint required' });
    }
    try {
      pushSubRepo.deleteByEndpoint(endpoint);
      return { ok: true };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // POST /api/notifications/test
  fastify.post('/api/notifications/test', async (request, reply) => {
    const subs = pushSubRepo.findAll();
    if (subs.length === 0) {
      return reply.status(400).send({ error: 'No push subscriptions registered' });
    }
    const result = await pushService.sendToAll(subs, (sub) => ({
      ...getPushMessage(sub.lang, 'test'),
      data: { url: '/' },
    }));
    return { ok: result.sent > 0, ...result };
  });

  // GET /api/agent-watches?endpoint=<url-encoded>
  fastify.get('/api/agent-watches', async (request, reply) => {
    const { endpoint } = request.query as { endpoint?: string };
    if (!endpoint) {
      return reply.status(400).send({ error: 'endpoint required' });
    }
    const watches = agentWatchRepo.findByEndpoint(endpoint);
    return watches.map((w) => ({ serverName: w.serverName, target: w.target, label: w.label }));
  });

  // POST /api/agent-watches
  fastify.post('/api/agent-watches', async (request, reply) => {
    const body = request.body as { endpoint?: string; serverName?: string; target?: string; label?: string };
    if (!body.endpoint || !body.serverName || !body.target) {
      return reply.status(400).send({ error: 'endpoint, serverName, target required' });
    }
    agentWatchRepo.add(body.endpoint, body.serverName, stripPaneSuffix(body.target), body.label ?? null);
    return { ok: true };
  });

  // DELETE /api/agent-watches
  fastify.delete('/api/agent-watches', async (request, reply) => {
    const body = request.body as { endpoint?: string; serverName?: string; target?: string };
    if (!body.endpoint || !body.serverName || !body.target) {
      return reply.status(400).send({ error: 'endpoint, serverName, target required' });
    }
    agentWatchRepo.removeByKey(body.endpoint, body.serverName, stripPaneSuffix(body.target));
    return { ok: true };
  });

  done();
};

export default notificationRoutes;
