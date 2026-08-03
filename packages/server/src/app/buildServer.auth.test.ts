import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';

const TOKEN = 'a'.repeat(64);
const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:3001'];

async function buildApp(): Promise<FastifyInstance> {
  const verifyUiToken = createTokenVerifier(TOKEN);
  const app = Fastify();

  await app.register(cors, { origin: ALLOWED_ORIGINS, credentials: false });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;
    if (request.url.startsWith('/api/health')) return;
    if (request.url.startsWith('/api/webhooks/')) return;
    if (request.url.startsWith('/api/agent-signal')) return;

    if (!verifyUiToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/api/test', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/webhooks/test', async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('buildServer auth hook', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('rejects /api/test without Authorization header with 401', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/test' });
    expect(res.statusCode).toBe(401);
  });

  it('allows /api/test with correct Bearer token', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects /api/test with wrong-length token with 401', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects /api/test with 1-char-different token with 401', async () => {
    app = await buildApp();
    const wrongToken = 'b' + TOKEN.slice(1);
    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { authorization: `Bearer ${wrongToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows /api/health without auth', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('allows /api/webhooks/test without UI token (excluded from UI auth)', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/webhooks/test' });
    expect(res.statusCode).toBe(200);
  });

  it('does not set access-control-allow-origin for disallowed origin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/test',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    const acao = res.headers['access-control-allow-origin'];
    expect(acao).not.toBe('*');
    expect(acao).not.toBe('https://evil.example');
  });

  it('sets access-control-allow-origin for allowed origin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/test',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects POST /api/system/update without auth with 401', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/update' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects GET /api/system/update/status without auth with 401', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/system/update/status' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects GET /api/system/update/progress without auth with 401', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/system/update/progress' });
    expect(res.statusCode).toBe(401);
  });
});
