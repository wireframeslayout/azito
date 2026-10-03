import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import webhookRoutes, { type WebhookRouteOptions, type MisaoWebhookOptions } from './webhooks';
import { createTokenVerifier } from '../servers/auth/tokenAuth';
import type { SqliteTaskRepository } from '../tasks/SqliteTaskRepository';
import type { ResolvedWindow } from '../operations/PaneHandleResolver';

const TOKEN = 'test-webhook-token';

function buildOptions(overrides: Partial<WebhookRouteOptions> = {}): WebhookRouteOptions {
  return {
    taskRepo: { findById: vi.fn().mockReturnValue(undefined) } as unknown as SqliteTaskRepository,
    verifyToken: createTokenVerifier(TOKEN),
    recordAgentActivity: vi.fn(),
    recordInteractionSignal: vi.fn(),
    misao: { resolvePane: vi.fn().mockResolvedValue(null), recordAgentActivity: vi.fn() },
    ...overrides,
  };
}

async function buildApp(options: WebhookRouteOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(webhookRoutes, options);
  await app.ready();
  return app;
}

const validActivityBody = {
  serverName: 'local',
  sessionName: 'azito',
  windowIndex: 3,
  windowName: 'agent-1',
  paneIndex: 1,
  event: 'start',
};

describe('POST /api/webhooks/agent-activity', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('rejects with 401 when the Authorization header is missing', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({ method: 'POST', url: '/api/webhooks/agent-activity', payload: validActivityBody });

    expect(res.statusCode).toBe(401);
    expect(options.recordAgentActivity).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token is incorrect', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-activity',
      headers: { authorization: 'Bearer wrong-token' },
      payload: validActivityBody,
    });

    expect(res.statusCode).toBe(401);
    expect(options.recordAgentActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['missing serverName', { ...validActivityBody, serverName: undefined }],
    ['empty serverName', { ...validActivityBody, serverName: '' }],
    ['missing sessionName', { ...validActivityBody, sessionName: undefined }],
    ['missing windowName', { ...validActivityBody, windowName: undefined }],
    ['non-numeric windowIndex', { ...validActivityBody, windowIndex: 'three' }],
    ['non-finite windowIndex', { ...validActivityBody, windowIndex: Infinity }],
    ['non-numeric paneIndex', { ...validActivityBody, paneIndex: 'one' }],
    ['invalid event', { ...validActivityBody, event: 'pause' }],
    ['missing event', { ...validActivityBody, event: undefined }],
  ])('rejects with 400 on %s', async (_label, payload) => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-activity',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(options.recordAgentActivity).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the body is not a JSON object', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-activity',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: 'null',
    });

    expect(res.statusCode).toBe(400);
  });

  it('calls recordAgentActivity with the parsed payload and returns 200 on success', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-activity',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: validActivityBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(options.recordAgentActivity).toHaveBeenCalledWith({
      serverName: 'local',
      sessionName: 'azito',
      windowIndex: 3,
      windowName: 'agent-1',
      paneIndex: 1,
      event: 'start',
    });
  });

  it('accepts event "stop"', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-activity',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...validActivityBody, event: 'stop' },
    });

    expect(res.statusCode).toBe(200);
    expect(options.recordAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ event: 'stop' }));
  });

  it('passes valid muxPaneRef through to recordAgentActivity', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-activity',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...validActivityBody, muxPaneRef: '%42' },
    });

    expect(res.statusCode).toBe(200);
    expect(options.recordAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ muxPaneRef: '%42' }));
  });

  it('ignores invalid muxPaneRef without rejecting the request', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    for (const bad of ['', 'no-percent', '%abc', '42']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/agent-activity',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...validActivityBody, muxPaneRef: bad },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(options.recordAgentActivity).toHaveBeenCalledTimes(4);
    for (const call of (options.recordAgentActivity as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].muxPaneRef).toBeUndefined();
    }
  });
});

const validInteractionBody = {
  serverName: 'local',
  sessionName: 'azito',
  windowIndex: 3,
  windowName: 'agent-1',
  paneIndex: 1,
  event: 'open',
};

describe('POST /api/webhooks/agent-interaction', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('rejects with 401 when the Authorization header is missing', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({ method: 'POST', url: '/api/webhooks/agent-interaction', payload: validInteractionBody });

    expect(res.statusCode).toBe(401);
    expect(options.recordInteractionSignal).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token is incorrect', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: 'Bearer wrong-token' },
      payload: validInteractionBody,
    });

    expect(res.statusCode).toBe(401);
    expect(options.recordInteractionSignal).not.toHaveBeenCalled();
  });

  it.each([
    ['missing serverName', { ...validInteractionBody, serverName: undefined }],
    ['empty serverName', { ...validInteractionBody, serverName: '' }],
    ['missing sessionName', { ...validInteractionBody, sessionName: undefined }],
    ['missing windowName', { ...validInteractionBody, windowName: undefined }],
    ['non-numeric windowIndex', { ...validInteractionBody, windowIndex: 'three' }],
    ['non-finite windowIndex', { ...validInteractionBody, windowIndex: Infinity }],
    ['non-numeric paneIndex', { ...validInteractionBody, paneIndex: 'one' }],
    ['event "cancel" (deferred to a future phase, not yet accepted)', { ...validInteractionBody, event: 'cancel' }],
    ['missing event', { ...validInteractionBody, event: undefined }],
  ])('rejects with 400 on %s', async (_label, payload) => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(options.recordInteractionSignal).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the body is not a JSON object', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: 'null',
    });

    expect(res.statusCode).toBe(400);
  });

  it('calls recordInteractionSignal with the parsed payload and returns 200 on success', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: validInteractionBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(options.recordInteractionSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'local',
        target: { sessionName: 'azito', windowIndex: 3, windowName: 'agent-1', paneIndex: 1 },
        event: 'open',
      }),
    );
  });

  it('forwards a well-formed content payload (PermissionRequest hook) as the signal content', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const content = {
      toolName: 'AskUserQuestion',
      questions: [
        {
          question: 'どれにしますか?',
          header: '選択',
          multiSelect: false,
          options: [{ label: 'はい', description: '進める' }, { label: 'いいえ' }],
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...validInteractionBody, content },
    });

    expect(res.statusCode).toBe(200);
    expect(options.recordInteractionSignal).toHaveBeenCalledWith(expect.objectContaining({ content }));
  });

  it('defaults an omitted multiSelect to false (the CLI omits it for single-select questions)', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        ...validInteractionBody,
        content: { toolName: 'AskUserQuestion', questions: [{ question: 'q', options: [{ label: 'a' }] }] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(options.recordInteractionSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { toolName: 'AskUserQuestion', questions: [{ question: 'q', multiSelect: false, options: [{ label: 'a' }] }] },
      }),
    );
  });

  it.each([
    ['not an object', 'nope'],
    ['missing toolName', { questions: [{ question: 'q', options: [{ label: 'a' }] }] }],
    ['empty questions', { toolName: 'AskUserQuestion', questions: [] }],
    ['questions not an array', { toolName: 'AskUserQuestion', questions: { question: 'q' } }],
    ['question without text', { toolName: 'AskUserQuestion', questions: [{ options: [{ label: 'a' }] }] }],
    ['question without options', { toolName: 'AskUserQuestion', questions: [{ question: 'q' }] }],
    ['option without a label', { toolName: 'AskUserQuestion', questions: [{ question: 'q', options: [{ description: 'd' }] }] }],
    ['non-string header', { toolName: 'AskUserQuestion', questions: [{ question: 'q', header: 3, options: [{ label: 'a' }] }] }],
  ])('accepts the signal but drops the content on malformed content (%s)', async (_label, content) => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...validInteractionBody, content },
    });

    expect(res.statusCode).toBe(200);
    expect(options.recordInteractionSignal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(options.recordInteractionSignal).mock.calls[0][0].content).toBeUndefined();
  });

  it('passes valid muxPaneRef through to recordInteractionSignal', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-interaction',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...validInteractionBody, muxPaneRef: '%7' },
    });

    expect(res.statusCode).toBe(200);
    expect(options.recordInteractionSignal).toHaveBeenCalledWith(expect.objectContaining({ muxPaneRef: '%7' }));
  });
});

describe('POST /api/webhooks/agent-done (unchanged behavior)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('rejects with 401 when the token is missing', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({ method: 'POST', url: '/api/webhooks/agent-done', payload: { server: 'local' } });

    expect(res.statusCode).toBe(401);
  });

  it('rejects with 400 when neither taskId nor server is provided', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-done',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with a bare server payload (no push side effect)', async () => {
    const options = buildOptions();
    app = await buildApp(options);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/agent-done',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { server: 'local', summary: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('hook webhooks from a misao pane (misaoPaneId)', () => {
  const PANE_ID = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXA';
  const resolvedWindow: ResolvedWindow = {
    windowId: 7,
    ref: { kind: 'misao', workspace: 'azito', window: 'w_01J8ZK3M5N7P9Q2R4S6T8V0WXY' },
    ordinal: 1,
    tmuxTarget: 'w_01J8ZK3M5N7P9Q2R4S6T8V0WXY',
  };
  let app: FastifyInstance;

  function misaoOptions(resolved: ResolvedWindow | null = resolvedWindow): { misao: MisaoWebhookOptions; options: WebhookRouteOptions } {
    const misao: MisaoWebhookOptions = {
      resolvePane: vi.fn().mockResolvedValue(resolved),
      recordAgentActivity: vi.fn(),
    };
    return { misao, options: buildOptions({ misao }) };
  }

  function post(url: string, payload: unknown) {
    return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${TOKEN}` }, payload: payload as Record<string, unknown> });
  }

  afterEach(async () => {
    await app.close();
  });

  it('agent-activity resolves the pane and records a Tier 1 hook signal for its window', async () => {
    const { misao, options } = misaoOptions();
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-activity', { serverName: 'local', misaoPaneId: PANE_ID, event: 'start' });

    expect(res.statusCode).toBe(200);
    expect(misao.resolvePane).toHaveBeenCalledWith('local', PANE_ID);
    expect(misao.recordAgentActivity).toHaveBeenCalledWith('local', resolvedWindow.tmuxTarget, 'start');
    expect(options.recordAgentActivity).not.toHaveBeenCalled();
  });

  it('agent-activity records nothing for a pane other than the first of its window', async () => {
    const { misao, options } = misaoOptions({ ...resolvedWindow, ordinal: 2 });
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-activity', { serverName: 'local', misaoPaneId: PANE_ID, event: 'stop' });

    expect(res.statusCode).toBe(200);
    expect(misao.recordAgentActivity).not.toHaveBeenCalled();
  });

  it('agent-activity answers 200 and records nothing when no window owns the pane', async () => {
    const { misao, options } = misaoOptions(null);
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-activity', { serverName: 'local', misaoPaneId: PANE_ID, event: 'stop' });

    expect(res.statusCode).toBe(200);
    expect(misao.recordAgentActivity).not.toHaveBeenCalled();
  });

  it.each(['%3', 'p_short', 42])('agent-activity rejects the invalid misaoPaneId %s with 400', async (misaoPaneId) => {
    const { options } = misaoOptions();
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-activity', { serverName: 'local', misaoPaneId, event: 'start' });

    expect(res.statusCode).toBe(400);
  });

  it('agent-activity still validates serverName and event on the misao branch', async () => {
    const { options } = misaoOptions();
    app = await buildApp(options);

    expect((await post('/api/webhooks/agent-activity', { misaoPaneId: PANE_ID, event: 'start' })).statusCode).toBe(400);
    expect((await post('/api/webhooks/agent-activity', { serverName: 'local', misaoPaneId: PANE_ID, event: 'bogus' })).statusCode).toBe(400);
  });

  it('agent-activity keeps the tmux path when tmux fields are present, even alongside misaoPaneId', async () => {
    const { misao, options } = misaoOptions();
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-activity', { ...validActivityBody, misaoPaneId: PANE_ID });

    expect(res.statusCode).toBe(200);
    expect(options.recordAgentActivity).toHaveBeenCalledTimes(1);
    expect(misao.resolvePane).not.toHaveBeenCalled();
  });

  it('agent-interaction records the signal against the resolved window id and pane ordinal', async () => {
    const { options } = misaoOptions();
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-interaction', { serverName: 'local', misaoPaneId: PANE_ID, event: 'open' });

    expect(res.statusCode).toBe(200);
    expect(options.recordInteractionSignal).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'local',
      target: { windowId: 7, paneIndex: 1 },
      event: 'open',
    }));
  });

  it('agent-interaction answers 200 and records nothing when no window owns the pane', async () => {
    const { options } = misaoOptions(null);
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-interaction', { serverName: 'local', misaoPaneId: PANE_ID, event: 'open' });

    expect(res.statusCode).toBe(200);
    expect(options.recordInteractionSignal).not.toHaveBeenCalled();
  });

  it('agent-interaction rejects an invalid misaoPaneId with 400', async () => {
    const { options } = misaoOptions();
    app = await buildApp(options);

    const res = await post('/api/webhooks/agent-interaction', { serverName: 'local', misaoPaneId: 'nope', event: 'open' });

    expect(res.statusCode).toBe(400);
  });
});
