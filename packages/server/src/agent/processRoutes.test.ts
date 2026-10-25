import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import processRoutes from './processRoutes';
import { agentAuthHook } from './authHook';
import type { ProcessEntry } from '../shared/os/processList';

const ENTRY: ProcessEntry = { pid: 10, ppid: 1, startMs: 1_700_000_000_000, executable: null, commandLine: 'claude --resume x', rssBytes: 2048 };

describe('agent processes route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    // Registered after the auth hook, as in agent/main.ts.
    app.addHook('onRequest', agentAuthHook((header) => header === 'Bearer secret'));
    await app.register(processRoutes, { listProcesses: async () => [ENTRY] });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires the agent token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/processes' })).statusCode).toBe(401);
  });

  it('lists the processes of the host', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/processes', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([ENTRY]);
  });
});

describe('agent processes route on a host that cannot list its processes', () => {
  it('answers 500 instead of an empty list', async () => {
    const app = Fastify();
    await app.register(processRoutes, { listProcesses: async () => { throw new Error('Listing processes failed (exit 1)'); } });
    const res = await app.inject({ method: 'GET', url: '/api/processes' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
