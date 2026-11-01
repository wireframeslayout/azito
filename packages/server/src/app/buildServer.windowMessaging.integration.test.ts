import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import windowsRoutes, { type WindowsRouteOptions } from '../modules/windows/routes';
import { resolvePrincipal } from '../shared/auth/resolvePrincipal';
import { evaluateRouteAuth } from '../shared/auth/routeAuth';
import { formatTaskToken } from '../shared/auth/taskTokenFormat';

const secret = 'b'.repeat(64);
const taskToken = formatTaskToken(7, secret);
const taskHeaders = { authorization: `Bearer ${taskToken}` };
const operatorHeaders = { authorization: 'Bearer operator' };

function buildApp(scoped: boolean) {
  const app = Fastify();
  const windows = new Map([
    [1, { id: 1, ownerType: 'task', taskId: 7, projectId: null, serverName: 'local', tmuxTarget: 's:a', sleeping: false }],
    [2, { id: 2, ownerType: 'project', taskId: null, projectId: 5, serverName: 'local', tmuxTarget: 's:b', sleeping: false }],
    [3, { id: 3, ownerType: 'task', taskId: 8, projectId: 6, serverName: 'local', tmuxTarget: 's:c', sleeping: false }],
    [4, { id: 4, ownerType: 'project', taskId: null, projectId: 5, serverName: 'local', tmuxTarget: 's:d', sleeping: true }],
  ]);
  const driver = { resolvePane: vi.fn().mockResolvedValue('%2'), pasteTextToHandle: vi.fn(), sendKeysToHandle: vi.fn() };
  const record = vi.fn();
  app.addHook('onRequest', async (request, reply) => {
    const principal = resolvePrincipal(request.headers.authorization, {
      verifyUiToken: (header) => header === operatorHeaders.authorization,
      taskTokenRepo: { verify: (id, value) => id === 7 && value === secret },
    });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;
    if (scoped && !evaluateRouteAuth(principal, request).allowed) return reply.status(403).send({ error: 'operator_required' });
  });
  app.register(windowsRoutes, {
    windowRepo: { findById: (id: number) => windows.get(id) },
    taskRepo: { findById: (id: number) => id === 7 ? { projectId: 5 } : undefined },
    serverRepo: { findByName: () => ({ name: 'local' }) },
    muxDriverRegistry: { resolve: () => driver },
    auditLogService: { record },
    paneHandleResolver: { invalidate: vi.fn(), resolveWindowByPaneHandle: vi.fn().mockResolvedValue({ windowId: 1 }) },
  } as unknown as WindowsRouteOptions);
  return { app, driver, record };
}

describe.each([false, true])('window messaging (scoped auth %s)', (scoped) => {
  it('authenticates identity and enforces ownership and project boundaries', async () => {
    const { app, driver, record } = buildApp(scoped);
    const who = await app.inject({ method: 'GET', url: '/api/windows/whoami?server=local&paneHandle=%2525', headers: taskHeaders });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ windowId: 1, idLabel: 'W-1', taskId: 7, serverName: 'local' });
    expect((await app.inject({ method: 'GET', url: '/api/windows/whoami?windowId=3', headers: taskHeaders })).statusCode).toBe(403);
    const send = (id: string, from: number, text = 'private') => app.inject({ method: 'POST', url: `/api/windows/${id}/messages`, headers: taskHeaders, payload: { from: { windowId: from }, text } });
    expect((await send('W-2', 1)).statusCode).toBe(200);
    expect((await send('2', 3)).statusCode).toBe(403);
    expect((await send('3', 1)).statusCode).toBe(403);
    expect((await send('4', 1)).statusCode).toBe(409);
    expect((await send('999', 1)).statusCode).toBe(404);
    expect((await send('win--abcd', 1)).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/windows/3/messages', headers: operatorHeaders, payload: { text: 'operator' } })).statusCode).toBe(200);
    expect(driver.pasteTextToHandle).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    await app.close();
  });
});
