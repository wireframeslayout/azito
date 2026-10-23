import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import hostRoutes from './hostRoutes';
import { agentAuthHook } from './authHook';

describe('agent host route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    // Registered after the auth hook, as in agent/main.ts.
    app.addHook('onRequest', agentAuthHook((header) => header === 'Bearer secret'));
    await app.register(hostRoutes, { host: { platform: 'linux', arch: 'x64', shell: '/bin/zsh' } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires the agent token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/host' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/host', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
  });

  it('reports the platform, architecture and default shell to the hub', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/host', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ platform: 'linux', arch: 'x64', shell: '/bin/zsh' });
  });
});

describe('agent host route without a default shell', () => {
  it('reports null instead of inventing one', async () => {
    const app = Fastify();
    await app.register(hostRoutes, { host: { platform: 'darwin', arch: 'arm64', shell: null } });
    const res = await app.inject({ method: 'GET', url: '/api/host' });
    expect(res.json()).toEqual({ platform: 'darwin', arch: 'arm64', shell: null });
    await app.close();
  });
});
