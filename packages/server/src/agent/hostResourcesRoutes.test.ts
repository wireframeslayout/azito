import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import hostResourcesRoutes from './hostResourcesRoutes';
import { agentAuthHook } from './authHook';
import type { HostResourceSample } from '../shared/os/hostResources';

const SAMPLE: HostResourceSample = { memTotalBytes: 16_000, memAvailableBytes: 8_000, disk: { usedBytes: 1, totalBytes: 2 } };

describe('agent host resources route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    // Registered after the auth hook, as in agent/main.ts.
    app.addHook('onRequest', agentAuthHook((header) => header === 'Bearer secret'));
    await app.register(hostResourcesRoutes, { measure: async () => SAMPLE });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires the agent token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/host/resources' })).statusCode).toBe(401);
  });

  it('reports the measurement of the host', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/host/resources', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SAMPLE);
  });

  it('answers 500 for a host that cannot be measured', async () => {
    const failing = Fastify();
    await failing.register(hostResourcesRoutes, { measure: async () => { throw new Error('no memory info'); } });
    expect((await failing.inject({ method: 'GET', url: '/api/host/resources' })).statusCode).toBe(500);
    await failing.close();
  });
});
