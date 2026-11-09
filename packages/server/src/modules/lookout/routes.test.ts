import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { lookoutRoutes } from './routes';

async function setup(principal: 'operator' | 'task' = 'operator') {
  const app = Fastify();
  app.addHook('onRequest', async (request) => { request.principal = { class: principal }; });
  const settings = { get: () => ({ enabled: false, provider: 'claude', model: 'sonnet', updatedAt: '' }), update: vi.fn((value) => value) };
  const service = { invalidate: vi.fn(), getSummaries: vi.fn(async () => []) };
  await app.register(lookoutRoutes, { settings: settings as never, service: service as never });
  return { app, settings, service };
}

describe('Lookout routes', () => {
  it('rejects invalid models and duplicate windows', async () => {
    const { app, settings } = await setup();
    try {
      for (const model of ['', '-bad', 'bad\nmodel']) {
        expect((await app.inject({ method: 'PUT', url: '/api/settings/lookout', payload: { enabled: true, provider: 'claude', model } })).statusCode).toBe(400);
      }
      expect(settings.update).not.toHaveBeenCalled();
      const windows = encodeURIComponent(JSON.stringify([{ windowId: 1, state: 'working' }, { windowId: 1, state: 'blocked' }]));
      expect((await app.inject({ method: 'GET', url: `/api/lookout/summaries?windows=${windows}` })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('limits summaries to operators', async () => {
    const { app, service } = await setup('task');
    try {
      expect((await app.inject({ method: 'GET', url: '/api/lookout/summaries?windows=%5B%5D' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: '/api/settings/lookout', payload: { enabled: true, provider: 'claude', model: 'sonnet' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/settings/lookout/probe' })).statusCode).toBe(403);
      expect(service.getSummaries).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
