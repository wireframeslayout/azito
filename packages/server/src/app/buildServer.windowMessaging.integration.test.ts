import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { TaskPaneEnvironmentService } from '../modules/tasks/execution/TaskPaneEnvironmentService';
import { composePaneEnv } from '../modules/tmux/hubPaneEnv';
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
    [1, { id: 1, ownerType: 'task', role: null, originProjectId: null, taskId: 7, projectId: null, serverName: 'local', tmuxTarget: 's:a', sleeping: false, isPrimary: true, workerType: 'claude' }],
    [2, { id: 2, ownerType: 'project', role: null, originProjectId: null, taskId: null, projectId: 5, serverName: 'local', tmuxTarget: 's:b', sleeping: false, workerType: 'claude' }],
    [3, { id: 3, ownerType: 'task', role: null, originProjectId: null, taskId: 8, projectId: 6, serverName: 'local', tmuxTarget: 's:c', sleeping: false, workerType: 'claude' }],
    [4, { id: 4, ownerType: 'project', role: null, originProjectId: null, taskId: null, projectId: 5, serverName: 'local', tmuxTarget: 's:d', sleeping: true, workerType: 'claude' }],
  ]);
  const driver = { submitInputByHandle: vi.fn().mockResolvedValue(undefined), caps: { copyMode: false }, captureScreen: vi.fn().mockResolvedValue({ code: 0, stdout: '──────────────\n❯\n──────────────\nbypass permissions on' }), resolvePane: vi.fn().mockResolvedValue('%2'), pasteTextToHandle: vi.fn(), sendKeysToHandle: vi.fn(), paneCommandByHandle: vi.fn().mockResolvedValue('claude') };
  const record = vi.fn();
  const recordInteraction = vi.fn();
  app.addHook('onRequest', async (request, reply) => {
    const principal = resolvePrincipal(request.headers.authorization, {
      verifyUiToken: (header) => header === operatorHeaders.authorization,
      taskTokenRepo: { verify: (id, value) => id === 7 && value === secret },
    });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;
    if (scoped && !evaluateRouteAuth(principal, request).allowed) return reply.status(403).send({ error: 'operator_required' });
  });
  const opts = {
    attribution: { recordInteraction },
    windowRoles: { set: vi.fn().mockReturnValue('ok') },
    windowRepo: { findById: (id: number) => windows.get(id), findByTask: (id: number) => [...windows.values()].filter((w) => w.taskId === id) },
    taskRepo: { findById: (id: number) => id === 7 ? { id: 7, projectId: 5, serverName: null } : undefined },
    serverRepo: { findByName: () => ({ name: 'local' }) },
    muxDriverRegistry: { resolveKind: () => driver, resolve: () => driver },
    auditLogService: { record },
    paneHandleResolver: { invalidate: vi.fn(), resolveWindowByPaneHandle: vi.fn().mockResolvedValue({ windowId: 1 }) },
  };
  app.register(windowsRoutes, opts as unknown as WindowsRouteOptions);
  return { app, driver, record, recordInteraction, paneHandleResolver: opts.paneHandleResolver };
}

describe.each([false, true])('window messaging (scoped auth %s)', (scoped) => {
  it('resolves and sends from an initial task pane with the actual composed environment', async () => {
    const { app } = buildApp(scoped);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const envService = new TaskPaneEnvironmentService(
      { issueNextGeneration: () => ({ id: 1, token: taskToken }) } as any,
      { findByProjectWithValues: () => [] } as any, 'operator', true, { record: vi.fn() } as any,
    );
    const server = { type: 'local', isolationIntent: false } as any;
    const env = composePaneEnv({ localUrl: address, publicUrl: address, webhookToken: 'hook', harnessPrefix: '' }, server,
      envService.buildEnvForNewWindow({ id: 7, projectId: 5 } as any, server).env);
    expect(env.AZITO_WINDOW_ID).toBeUndefined();
    expect(env.AZITO_SERVER_NAME).toBeUndefined();
    const script = path.resolve(__dirname, '../../../../harness/bin/azitoctl.mjs');
    const run = promisify(execFile);
    const options = { env: { PATH: process.env.PATH, ...env, TMUX_PANE: '%25' } };
    try {
      expect((await run(process.execPath, [script, 'whoami'], options)).stdout).toContain('W-1 task=#7');
      expect((await run(process.execPath, [script, 'send', '--window', 'W-2', 'hello'], options)).stdout).toContain('Sent to W-2');
    } finally { await app.close(); }
  });

  it('authenticates identity and enforces ownership and project boundaries', async () => {
    const { app, driver, record, paneHandleResolver } = buildApp(scoped);
    const who = await app.inject({ method: 'GET', url: '/api/windows/whoami?paneHandle=%2525', headers: taskHeaders });
    expect(who.statusCode).toBe(200);
    // Only the asking pane is looked up again; the server's other cached panes are left alone.
    expect(paneHandleResolver.resolveWindowByPaneHandle).toHaveBeenCalledWith('local', '%25', { fresh: true });
    expect(paneHandleResolver.invalidate).not.toHaveBeenCalled();
    expect(who.json()).toMatchObject({ windowId: 1, idLabel: 'W-1', taskId: 7, serverName: 'local' });
    expect((await app.inject({ method: 'GET', url: '/api/windows/whoami?windowId=3', headers: taskHeaders })).statusCode).toBe(403);
    const missingServer = await app.inject({ method: 'GET', url: '/api/windows/whoami?paneHandle=%2525', headers: operatorHeaders });
    expect(missingServer.statusCode).toBe(400);
    expect(missingServer.json()).toEqual({ error: 'server is required' });
    const send = (id: string, from: number, text = 'private') => app.inject({ method: 'POST', url: `/api/windows/${id}/messages`, headers: taskHeaders, payload: { from: { windowId: from }, text } });
    expect((await send('W-2', 1)).statusCode).toBe(200);
    expect((await send('2', 3)).statusCode).toBe(403);
    expect((await send('3', 1)).statusCode).toBe(403);
    const sleeping = await send('4', 1);
    expect(sleeping.statusCode).toBe(409);
    expect(sleeping.json()).toEqual({ error: 'Window is sleeping' });
    driver.captureScreen.mockResolvedValueOnce({ code: 0, stdout: 'Do you trust this folder?' });
    const dialog = await send('2', 1);
    expect(dialog.statusCode).toBe(409);
    expect(dialog.json()).toEqual({ error: 'The agent is waiting for a dialog to be resolved.' });

    expect((await send('999', 1)).statusCode).toBe(404);
    expect((await send('win--abcd', 1)).statusCode).toBe(400);
    expect((await send('2', 1, 'hi\x1b[2Jthere')).statusCode).toBe(400);
    expect((await send('2', 1, 'x'.repeat(32769))).statusCode).toBe(400);
    expect((await send('2', 1, 'x'.repeat(32768))).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/windows/3/messages', headers: operatorHeaders, payload: { text: 'operator' } })).statusCode).toBe(200);
    expect(driver.pasteTextToHandle).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    await app.close();
  });
});


it('records successful messages from the attribution header and keeps role API operator-only', async () => {
  const { app, recordInteraction } = buildApp(true);
  const message = await app.inject({ method: 'POST', url: '/api/windows/2/messages', headers: { ...operatorHeaders, 'x-azito-window-id': '1' }, payload: { text: 'hello' } });
  expect(message.statusCode).toBe(200);
  expect(recordInteraction).toHaveBeenCalledWith(1, { windowId: 2 });
  const denied = await app.inject({ method: 'PUT', url: '/api/windows/2/role', headers: taskHeaders, payload: { role: 'orchestrator' } });
  expect(denied.statusCode).toBe(403);
  const allowed = await app.inject({ method: 'PUT', url: '/api/windows/2/role', headers: operatorHeaders, payload: { role: 'orchestrator' } });
  expect(allowed.statusCode).toBe(200);
  await app.close();
});


it('records successful capture and send-keys calls', async () => {
  const { app, recordInteraction } = buildApp(true);
  const headers = { ...operatorHeaders, 'x-azito-window-id': '1' };
  const capture = await app.inject({ method: 'GET', url: '/api/windows/2/panes/1/capture?history=10', headers });
  expect(capture.statusCode).toBe(200);
  const send = await app.inject({ method: 'POST', url: '/api/windows/2/panes/1/send-keys', headers, payload: { keys: ['Enter'] } });
  expect(send.statusCode).toBe(200);
  expect(recordInteraction).toHaveBeenCalledTimes(2);
  expect(recordInteraction).toHaveBeenCalledWith(1, { windowId: 2 });
  await app.close();
});
