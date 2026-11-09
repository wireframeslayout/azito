import { SqliteWindowLinkRepository } from './SqliteWindowLinkRepository';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { openDatabase } from '../../shared/db/Database';
import { SqliteWindowRepository } from '../windows/SqliteWindowRepository';
import type { ITaskRepository } from '../tasks/Task';
import { NotificationBus } from '../notifications/NotificationBus';
import { OrchestrationLinkService } from './OrchestrationLinkService';
import routes from './routes';
import { evaluateRouteAuth } from '../../shared/auth/routeAuth';

describe('orchestration routes', () => {
  it('adds, lists, unlinks and manually restores links', async () => {
    const db = openDatabase(':memory:');
    db.exec("INSERT INTO windows (id,owner_type,server_name,tmux_target,window_type,worker_type,role) VALUES (1,'server','local','s:a','agent','claude','orchestrator'), (2,'server','local','s:b','agent','claude','orchestrator')");
    const windows = new SqliteWindowRepository(db); const bus = new NotificationBus();
    const links = new OrchestrationLinkService(new SqliteWindowLinkRepository(db), windows, { findById: vi.fn() } as unknown as ITaskRepository, bus);
    const app = Fastify(); await app.register(routes, { links, windows });
    const request = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload });
    expect((await request('POST', '/api/windows/1/links', { targetWindowId: 2, taskId: 1 })).statusCode).toBe(400);
    const add = await request('POST', '/api/windows/1/links', { targetWindowId: 2 });
    expect(add.statusCode).toBe(200); const id = add.json().id;
    expect((await request('GET', '/api/windows/1/links')).json()).toHaveLength(1);
    expect((await request('DELETE', `/api/windows/1/links/${id}`)).statusCode).toBe(200);
    expect((await request('GET', '/api/windows/1/links')).json()).toHaveLength(0);
    expect((await request('GET', '/api/windows/1/links?includeUnlinked=1')).json()).toHaveLength(1);
    expect((await request('POST', '/api/windows/1/links', { targetWindowId: 2 })).json().id).toBe(id);
    expect((await request('GET', '/api/orchestrators')).json()).toHaveLength(2);
    await app.close(); bus.destroy(); db.close();
  });
  it('keeps every link route operator-only', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request, reply) => {
      const principal = request.headers.authorization === 'operator' ? { class: 'operator' as const } : { class: 'task' as const, id: 1 };
      if (!evaluateRouteAuth(principal, request).allowed) return reply.status(403).send();
    });
    await app.register(routes, { links: { orchestrators: () => [], list: () => [], add: () => 'not_found', unlink: () => false } as unknown as OrchestrationLinkService, windows: { findById: () => ({ id: 1 }) } as unknown as SqliteWindowRepository });
    for (const [method, url, payload] of [
      ['GET', '/api/orchestrators', undefined], ['GET', '/api/windows/1/links', undefined],
      ['POST', '/api/windows/1/links', { targetWindowId: 2 }], ['DELETE', '/api/windows/1/links/1', undefined],
    ] as const) {
      expect((await app.inject({ method, url, payload, headers: { authorization: 'task' } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, payload, headers: { authorization: 'operator' } })).statusCode).not.toBe(403);
    }
    await app.close();
  });

});
