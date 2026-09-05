import type { FastifyPluginCallback } from 'fastify';
import type { SqliteTaskRepository } from '../tasks/SqliteTaskRepository';
import type { AgentHookSignal } from '../operations/AgentActivityMonitor';
import type { InteractionSignal, InteractionContent, InteractionQuestion, InteractionQuestionOption } from './InteractionMonitor';

export interface WebhookRouteOptions {
  taskRepo: SqliteTaskRepository;
  verifyToken: (authHeader: string | undefined) => boolean;
  recordAgentActivity: (signal: AgentHookSignal) => void;
  /** v1 only ever receives event: 'open' — see InteractionMonitor's doc comment. */
  recordInteractionSignal: (signal: InteractionSignal) => void;
}

/**
 * Parse the optional `content` field of an agent-interaction signal (the AskUserQuestion
 * `tool_input` forwarded by `harness/hooks/azito-question.sh`). Returns `undefined` for both
 * "absent" and "malformed": a signal whose content we cannot trust is still a valid
 * pending-answer signal, so it is accepted with the content dropped — the chat view then falls
 * back to the banner instead of an answerable card. Rejecting the whole request would trade a
 * degraded card for no signal at all, which is strictly worse.
 *
 * Hand-written rather than schema-driven, matching the sibling validation in this file.
 */
function parseInteractionContent(raw: unknown): InteractionContent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { toolName, questions } = raw as { toolName?: unknown; questions?: unknown };
  if (typeof toolName !== 'string' || toolName === '') return undefined;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;

  const parsed: InteractionQuestion[] = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') return undefined;
    const { question, header, multiSelect, options } = q as {
      question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown;
    };
    if (typeof question !== 'string' || question === '') return undefined;
    if (header !== undefined && typeof header !== 'string') return undefined;
    if (multiSelect !== undefined && typeof multiSelect !== 'boolean') return undefined;
    if (!Array.isArray(options) || options.length === 0) return undefined;

    const parsedOptions: InteractionQuestionOption[] = [];
    for (const o of options) {
      if (!o || typeof o !== 'object') return undefined;
      const { label, description } = o as { label?: unknown; description?: unknown };
      if (typeof label !== 'string' || label === '') return undefined;
      if (description !== undefined && typeof description !== 'string') return undefined;
      parsedOptions.push(description === undefined ? { label } : { label, description });
    }

    parsed.push({
      question,
      ...(header === undefined ? {} : { header }),
      // multiSelect drives whether the chat can answer with a single keystroke, so an absent
      // value must mean "single select" (the CLI omits it in that case), not "unknown".
      multiSelect: multiSelect === true,
      options: parsedOptions,
    });
  }

  return { toolName, questions: parsed };
}

const webhookRoutes: FastifyPluginCallback<WebhookRouteOptions> = (fastify, opts, done) => {
  const { taskRepo, verifyToken, recordAgentActivity, recordInteractionSignal } = opts;

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
      muxPaneRef?: unknown;
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

    const muxPaneRef = typeof body.muxPaneRef === 'string' && /^%\d+$/.test(body.muxPaneRef)
      ? body.muxPaneRef : undefined;

    recordAgentActivity({
      serverName: body.serverName,
      sessionName: body.sessionName,
      windowIndex: body.windowIndex,
      windowName: body.windowName,
      paneIndex: body.paneIndex,
      event: body.event,
      muxPaneRef,
    });

    return { ok: true };
  });

  // ── POST /api/webhooks/agent-interaction ── Notification hook signal ("agent is waiting
  // for an answer", Phase B real-time pending-answer detection). Same token/body-validation
  // pattern as agent-activity. v1 only accepts event: 'open' — 'cancel' is reserved for a
  // future phase (see InteractionMonitor's doc comment) and is rejected here as an unknown value.
  // The optional `content` field carries the AskUserQuestion tool_input when the signal comes from
  // the PermissionRequest hook (azito-question.sh); see parseInteractionContent for why malformed
  // content degrades the signal instead of failing the request.
  fastify.post('/api/webhooks/agent-interaction', async (request, reply) => {
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
      content?: unknown;
      muxPaneRef?: unknown;
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
    if (body.event !== 'open') {
      return reply.status(400).send({ error: 'event must be "open"' });
    }

    const content = parseInteractionContent(body.content);
    const interactionMuxPaneRef = typeof body.muxPaneRef === 'string' && /^%\d+$/.test(body.muxPaneRef)
      ? body.muxPaneRef : undefined;

    recordInteractionSignal({
      serverName: body.serverName,
      target: {
        sessionName: body.sessionName,
        windowIndex: body.windowIndex,
        windowName: body.windowName,
        paneIndex: body.paneIndex,
      },
      event: body.event,
      timestamp: Date.now(),
      ...(content === undefined ? {} : { content }),
      muxPaneRef: interactionMuxPaneRef,
    });

    return { ok: true };
  });

  done();
};

export default webhookRoutes;
