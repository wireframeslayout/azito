import path from 'node:path';
import type { FastifyPluginCallback } from 'fastify';
import type { SqliteTaskRepository } from '../tasks/SqliteTaskRepository';
import type { AgentHookSignal } from '../operations/AgentActivityMonitor';
import type { InteractionSignal, InteractionContent, InteractionQuestion, InteractionQuestionOption } from './InteractionMonitor';
import { isPaneHandleLike } from '@azito/shared';
import type { ResolvedWindow } from '../operations/PaneHandleResolver';

/**
 * Hook signals from a misao pane, which has no tmux coordinates and identifies itself by its pane id
 * (`$MISAO_PANE_ID`, sent as `misaoPaneId`). Takes effect only when the body carries no tmux fields.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MisaoWebhookOptions {
  /** The window a misao pane belongs to, or null when no registered window owns it or the daemon cannot be reached. */
  resolvePane: (serverName: string, paneId: string) => Promise<ResolvedWindow | null>;
  recordClaudeSessionHook?: (serverName: string, paneId: string, sessionId: string, configDir: string, timestamp: string, explicit: boolean) => boolean;
  recordAgentActivity: (serverName: string, tmuxTarget: string, event: AgentHookSignal['event'], sessionId?: string, claudeConfigDir?: string, paneOrdinal?: number, claudeConfigDirExplicit?: boolean) => void;
}

export interface WebhookRouteOptions {
  taskRepo: SqliteTaskRepository;
  verifyToken: (authHeader: string | undefined) => boolean;
  /**
   * Maps the `serverName` a hook sends to the current server name: a pane started before migration 079 merged
   * its server into another still carries the old name in its environment.
   * TODO(#313): compatibility for one release; remove with the `server_aliases` table.
   */
  resolveServerName: (name: string) => string;
  recordAgentActivity: (signal: AgentHookSignal) => void;
  /** v1 only ever receives event: 'open' — see InteractionMonitor's doc comment. */
  recordInteractionSignal: (signal: InteractionSignal) => void;
  recordSubagentSignal: (serverName: string, paneId: string, sessionId: string) => Promise<void>;
  misao: MisaoWebhookOptions;
}

interface HookSignalBody {
  serverName?: unknown;
  sessionName?: unknown;
  windowIndex?: unknown;
  windowName?: unknown;
  paneIndex?: unknown;
  misaoPaneId?: unknown;
}

/**
 * The misao pane id a hook body carries instead of tmux coordinates: `undefined` when this is a tmux signal,
 * `null` when the field is present but is not a misao pane id.
 */
function readMisaoPaneId(body: HookSignalBody): string | null | undefined {
  if (body.misaoPaneId === undefined) return undefined;
  const hasTmuxFields = [body.sessionName, body.windowIndex, body.windowName, body.paneIndex].some((v) => v !== undefined);
  if (hasTmuxFields) return undefined;
  return typeof body.misaoPaneId === 'string' && isPaneHandleLike(body.misaoPaneId, 'misao') ? body.misaoPaneId : null;
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
  const { taskRepo, verifyToken, resolveServerName, recordAgentActivity, recordInteractionSignal, misao } = opts;

  fastify.post('/api/webhooks/agent-subagent', async (request, reply) => {
    if (!verifyToken(request.headers.authorization)) return reply.status(401).send({ error: 'Unauthorized' });
    const body = request.body as (HookSignalBody & { sessionId?: unknown; muxPaneRef?: unknown; event?: unknown }) | null;
    if (!body || typeof body !== 'object' || typeof body.serverName !== 'string' || !body.serverName ||
        typeof body.sessionId !== 'string' || !SESSION_ID_RE.test(body.sessionId) || body.event !== 'subagent') {
      return reply.status(400).send({ error: 'Invalid subagent signal' });
    }
    const misaoPaneId = readMisaoPaneId(body);
    const paneId = misaoPaneId === undefined ? body.muxPaneRef : misaoPaneId;
    if (typeof paneId !== 'string' || !isPaneHandleLike(paneId, misaoPaneId === undefined ? 'tmux' : 'misao')) {
      return reply.status(400).send({ error: 'Invalid pane id' });
    }
    await opts.recordSubagentSignal(resolveServerName(body.serverName), paneId, body.sessionId);
    return { ok: true };
  });

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
      misaoPaneId?: unknown;
      sessionId?: unknown;
      claudeConfigDir?: unknown;
      claudeConfigDirExplicit?: unknown;
      hookTimestamp?: unknown;
    };

    const invalidConfig = body.claudeConfigDir !== undefined && (typeof body.claudeConfigDir !== 'string' || body.claudeConfigDir.length === 0 || body.claudeConfigDir.length > 4096 || body.claudeConfigDir.includes('\0') || !path.posix.isAbsolute(body.claudeConfigDir));
    const invalidExplicit = body.claudeConfigDirExplicit !== undefined && typeof body.claudeConfigDirExplicit !== 'boolean';
    const invalidTimestamp = body.hookTimestamp !== undefined && (typeof body.hookTimestamp !== 'string' || !/^[0-9]{1,20}$/.test(body.hookTimestamp));
    const invalidMetadata = invalidConfig || invalidExplicit || invalidTimestamp;
    if (invalidMetadata) request.log.warn('Ignoring invalid Claude session configuration metadata; preserving session ID');
    const claudeConfigDirExplicit = !invalidMetadata && typeof body.claudeConfigDirExplicit === 'boolean' ? body.claudeConfigDirExplicit : undefined;
    const hookTimestamp = !invalidMetadata && typeof body.hookTimestamp === 'string' ? body.hookTimestamp : undefined;
    const claudeConfigDir = !invalidMetadata && body.event === 'session' && typeof body.claudeConfigDir === 'string' ? body.claudeConfigDir : undefined;
    const sessionId = typeof body.sessionId === 'string' && SESSION_ID_RE.test(body.sessionId)
      ? body.sessionId : undefined;
    const misaoPaneId = readMisaoPaneId(body);
    if (misaoPaneId !== undefined) {
      if (typeof body.serverName !== 'string' || body.serverName === '') {
        return reply.status(400).send({ error: 'serverName required' });
      }
      if (misaoPaneId === null) {
        return reply.status(400).send({ error: 'misaoPaneId must be a misao pane id' });
      }
      if (body.event !== 'start' && body.event !== 'stop' && body.event !== 'session') {
        return reply.status(400).send({ error: 'event must be "start", "stop" or "session"' });
      }
      if (body.event === 'session' && sessionId && claudeConfigDir && hookTimestamp && claudeConfigDirExplicit !== undefined && misao.recordClaudeSessionHook) {
        if (misao.recordClaudeSessionHook(resolveServerName(body.serverName), misaoPaneId, sessionId, claudeConfigDir, hookTimestamp, claudeConfigDirExplicit)) return { ok: true };
      }
      const resolved = await misao.resolvePane(resolveServerName(body.serverName), misaoPaneId);
      // Only the first pane carries the window's agent state; a split pane's hook must not stand in for it.
      if (resolved && (resolved.ordinal === 1 || body.event === 'session')) misao.recordAgentActivity(resolveServerName(body.serverName), resolved.tmuxTarget, body.event, sessionId, claudeConfigDir, resolved.ordinal, claudeConfigDirExplicit);
      return { ok: true };
    }

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
    if (body.event !== 'start' && body.event !== 'stop' && body.event !== 'session') {
      return reply.status(400).send({ error: 'event must be "start", "stop" or "session"' });
    }

    const muxPaneRef = typeof body.muxPaneRef === 'string' && isPaneHandleLike(body.muxPaneRef, 'tmux')
      ? body.muxPaneRef : undefined;

    recordAgentActivity({
      serverName: resolveServerName(body.serverName),
      sessionName: body.sessionName,
      windowIndex: body.windowIndex,
      windowName: body.windowName,
      paneIndex: body.paneIndex,
      event: body.event,
      muxPaneRef,
      sessionId,
      claudeConfigDir,
      ...(claudeConfigDirExplicit !== undefined ? { claudeConfigDirExplicit } : {}),
      hookTimestamp,
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
      misaoPaneId?: unknown;
    };

    const misaoPaneId = readMisaoPaneId(body);
    if (misaoPaneId !== undefined) {
      if (typeof body.serverName !== 'string' || body.serverName === '') {
        return reply.status(400).send({ error: 'serverName required' });
      }
      if (misaoPaneId === null) {
        return reply.status(400).send({ error: 'misaoPaneId must be a misao pane id' });
      }
      if (body.event !== 'open') {
        return reply.status(400).send({ error: 'event must be "open"' });
      }
      const resolved = await misao.resolvePane(resolveServerName(body.serverName), misaoPaneId);
      const misaoContent = parseInteractionContent(body.content);
      if (resolved) {
        recordInteractionSignal({
          serverName: resolveServerName(body.serverName),
          target: { windowId: resolved.windowId, paneIndex: resolved.ordinal },
          event: body.event,
          timestamp: Date.now(),
          ...(misaoContent === undefined ? {} : { content: misaoContent }),
        });
      }
      return { ok: true };
    }

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
    const interactionMuxPaneRef = typeof body.muxPaneRef === 'string' && isPaneHandleLike(body.muxPaneRef, 'tmux')
      ? body.muxPaneRef : undefined;

    recordInteractionSignal({
      serverName: resolveServerName(body.serverName),
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
