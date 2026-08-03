import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import hooksRoutes from './hooks';
import type { NotificationBus } from '../../notifications/NotificationBus';

const VALID_TOKEN = 'test-webhook-token-abc123';

function makeNotificationBus(): NotificationBus & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
  } as unknown as NotificationBus & { emit: ReturnType<typeof vi.fn> };
}

function makeVerifyToken(validToken: string): (authHeader: string | undefined) => boolean {
  return (authHeader) => authHeader === `Bearer ${validToken}`;
}

async function buildApp(notificationBus: NotificationBus): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(hooksRoutes, { notificationBus, verifyToken: makeVerifyToken(VALID_TOKEN) });
  await app.ready();
  return app;
}

describe('POST /api/hooks/tmux', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when no authorization header is provided', async () => {
    const notificationBus = makeNotificationBus();
    app = await buildApp(notificationBus);

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/tmux?event=window-linked&server=srv1&session=normal',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(notificationBus.emit).not.toHaveBeenCalled();
  });

  it('returns 401 when an invalid token is provided', async () => {
    const notificationBus = makeNotificationBus();
    app = await buildApp(notificationBus);

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/tmux?event=window-linked&server=srv1&session=normal',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(notificationBus.emit).not.toHaveBeenCalled();
  });

  it('ignores the event and does not emit when session is a linked-viewer session (_azito_ prefix)', async () => {
    const notificationBus = makeNotificationBus();
    app = await buildApp(notificationBus);

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/tmux?event=window-linked&server=srv1&session=_azito_abc123',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ignored: true });
    expect(notificationBus.emit).not.toHaveBeenCalled();
  });

  it('emits when session is a normal (non-linked-viewer) session', async () => {
    const notificationBus = makeNotificationBus();
    app = await buildApp(notificationBus);

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/tmux?event=window-linked&server=srv1&session=normal',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(notificationBus.emit).toHaveBeenCalledWith({
      type: 'sessions:updated',
      payload: { serverName: 'srv1' },
    });
  });

  it('emits when session is omitted (backward compatibility with older hooks)', async () => {
    const notificationBus = makeNotificationBus();
    app = await buildApp(notificationBus);

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/tmux?event=window-linked&server=srv1',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(notificationBus.emit).toHaveBeenCalledWith({
      type: 'sessions:updated',
      payload: { serverName: 'srv1' },
    });
  });
});
