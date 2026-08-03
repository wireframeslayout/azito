import type { FastifyPluginCallback } from 'fastify';
import type { NotificationBus } from '../../notifications/NotificationBus';
import { invalidateSessionCache } from './sessions';

export interface HooksRouteOptions {
  notificationBus: NotificationBus;
  verifyToken: (authHeader: string | undefined) => boolean;
}

const VALID_EVENTS = new Set([
  'window-linked',
  'window-unlinked',
  'after-rename-window',
  'after-kill-pane',
  'session-window-changed',
  'session-closed',
  'after-select-pane',
]);

const hooksRoutes: FastifyPluginCallback<HooksRouteOptions> = (fastify, opts, done) => {
  const { notificationBus, verifyToken } = opts;

  fastify.post('/api/hooks/tmux', async (request, reply) => {
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { event, server, session } = request.query as { event?: string; server?: string; session?: string };
    if (!event || !server || !VALID_EVENTS.has(event)) {
      return reply.status(400).send({ error: 'invalid event or server' });
    }
    if (session && session.startsWith('_azito_') && event !== 'after-select-pane') {
      return { ok: true, ignored: true };
    }
    fastify.log.info(`[tmux-hook] event=${event} server=${server}`);
    invalidateSessionCache(server);
    notificationBus.emit({ type: 'sessions:updated', payload: { serverName: server } });
    return { ok: true };
  });

  done();
};

export default hooksRoutes;
