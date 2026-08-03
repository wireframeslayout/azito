import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import webhookRoutes, { type WebhookRouteOptions } from './webhooks';
import { createTokenVerifier } from '../servers/auth/tokenAuth';
import type { SqliteTaskRepository } from '../tasks/SqliteTaskRepository';

const TOKEN = 'test-webhook-token';

function buildOptions(overrides: Partial<WebhookRouteOptions> = {}): WebhookRouteOptions {
  return {
    taskRepo: { findById: vi.fn().mockReturnValue(undefined) } as unknown as SqliteTaskRepository,
    verifyToken: createTokenVerifier(TOKEN),
    recordAgentActivity: vi.fn(),
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
