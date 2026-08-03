import type { FastifyPluginCallback } from 'fastify';
import type { SqliteTaskRepository } from '../tasks/SqliteTaskRepository';
import type { AgentHookSignal } from '../operations/AgentActivityMonitor';

export interface WebhookRouteOptions {
  taskRepo: SqliteTaskRepository;
  verifyToken: (authHeader: string | undefined) => boolean;
  recordAgentActivity: (signal: AgentHookSignal) => void;
}

const webhookRoutes: FastifyPluginCallback<WebhookRouteOptions> = (fastify, opts, done) => {
  const { taskRepo, verifyToken, recordAgentActivity } = opts;

  fastify.post('/api/webhooks/agent-done', async (request, reply) => {
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const raw = request.body;
    if (!raw || typeof raw !== 'object') {
      return reply.status(400).send({ error: 'JSON body required' });
    }
    const body = raw as {
      taskId?: number;
      server?: string;
      window?: string;
      status?: string;
      summary?: string;
    };

    if (body.taskId !== undefined) {
      const task = taskRepo.findById(body.taskId);
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      if (task.status === 'done' || task.status === 'failed') {
        return { ok: true };
      }

      return { ok: true };
    }

    if (body.server !== undefined) {
      return { ok: true };
    }

    return reply.status(400).send({ error: 'taskId or server required' });
  });

  fastify.post('/api/webhooks/agent-activity', async (request, reply) => {
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const raw = request.body;
    if (!raw || typeof raw !== 'object') {
      return reply.status(400).send({ error: 'JSON body required' });
    }
    const body = raw as {
      serverName?: unknown;
      sessionName?: unknown;
      windowIndex?: unknown;
      windowName?: unknown;
      paneIndex?: unknown;
      event?: unknown;
    };

    if (typeof body.serverName !== 'string' || body.serverName === '') {
      return reply.status(400).send({ error: 'serverName required' });
    }
    if (typeof body.sessionName !== 'string' || body.sessionName === '') {
      return reply.status(400).send({ error: 'sessionName required' });
    }
    if (typeof body.windowName !== 'string' || body.windowName === '') {
      return reply.status(400).send({ error: 'windowName required' });
    }
    if (typeof body.windowIndex !== 'number' || !Number.isFinite(body.windowIndex)) {
      return reply.status(400).send({ error: 'windowIndex must be a finite number' });
    }
    if (typeof body.paneIndex !== 'number' || !Number.isFinite(body.paneIndex)) {
      return reply.status(400).send({ error: 'paneIndex must be a finite number' });
    }
    if (body.event !== 'start' && body.event !== 'stop') {
      return reply.status(400).send({ error: 'event must be "start" or "stop"' });
    }

    recordAgentActivity({
      serverName: body.serverName,
      sessionName: body.sessionName,
      windowIndex: body.windowIndex,
      windowName: body.windowName,
      paneIndex: body.paneIndex,
      event: body.event,
    });

    return { ok: true };
  });

  done();
};

export default webhookRoutes;
