import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapAppError } from '../../../app/mapAppError';
import { OPERATOR_PRINCIPAL, type Principal } from '../../../shared/auth/Principal';
import type { HostProfile } from '../../../shared/os/hostProfile';
import { KeyedMutex } from '../../../shared/keyedMutex';
import type { ServerConfig } from '../Server';
import agentUninstallRoutes from './agentUninstallRoutes';
import type { WindowsUninstallResult } from './windowsAgentUninstall';

const WIN32: HostProfile = { platform: 'win32', arch: 'x64' };
const server = (over: Partial<ServerConfig>): ServerConfig => ({ name: 'w1', type: 'agent', host: '100.64.0.7', agentPort: 3002, agentToken: 'tok', sshHost: 'dev@win', hostProfile: WIN32, ...over }) as ServerConfig;

const RESULT: WindowsUninstallResult = {
  ok: true,
  steps: [{ id: 'task', outcome: 'done' }, { id: 'processes', outcome: 'done' }, { id: 'firewall', outcome: 'absent' }, { id: 'folder', outcome: 'done' }],
};

describe('POST /api/servers/:name/agent/uninstall', () => {
  let app: FastifyInstance;
  let principal: Principal | undefined;
  let servers: Record<string, ServerConfig>;
  let mutex: KeyedMutex;
  const uninstallFromWindowsHost = vi.fn();

  beforeEach(async () => {
    principal = OPERATOR_PRINCIPAL;
    servers = { w1: server({}), l1: server({ name: 'l1', hostProfile: { platform: 'linux', arch: 'x64' } }), m1: server({ name: 'm1', hostProfile: { platform: 'darwin', arch: 'arm64' } }), u1: server({ name: 'u1', hostProfile: null }), loc: server({ name: 'loc', type: 'local', hostProfile: WIN32 }) };
    mutex = new KeyedMutex();
    uninstallFromWindowsHost.mockReset().mockResolvedValue(RESULT);
    app = Fastify();
    // As in app/buildServer.ts: a domain error with its own answer is mapped before the default handler.
    const defaultHandler = app.errorHandler;
    app.setErrorHandler((err, request, reply) => {
      const mapped = mapAppError(err);
      if (mapped) return reply.status(mapped.status).send(mapped.body);
      return defaultHandler.call(app, err, request, reply);
    });
    app.addHook('onRequest', async (request) => { request.principal = principal; });
    await app.register(agentUninstallRoutes, {
      serverRepo: { findByName: (name: string) => servers[name] ?? null },
      agentInstaller: { uninstallFromWindowsHost },
      serverIsolationMutex: mutex,
    });
  });
  afterEach(async () => { await app.close(); });

  const post = (name: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api/servers/${name}/agent/uninstall`, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('removes the agent from a Windows host and answers with the result of each step', async () => {
    const res = await post('w1', { removeMisao: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RESULT);
    expect(uninstallFromWindowsHost).toHaveBeenCalledWith('dev@win', { removeMisao: false });
  });

  it('leaves the misao alone unless asked, and passes the choice when it is', async () => {
    await post('w1');
    expect(uninstallFromWindowsHost).toHaveBeenLastCalledWith('dev@win', { removeMisao: false });
    await post('w1', { removeMisao: true });
    expect(uninstallFromWindowsHost).toHaveBeenLastCalledWith('dev@win', { removeMisao: true });
  });

  it('answers a failed step as a result with ok: false (not an error), so the caller can show each step', async () => {
    const failed: WindowsUninstallResult = { ok: false, steps: [{ id: 'task', outcome: 'done' }, { id: 'firewall', outcome: 'failed', detail: 'not elevated' }] };
    uninstallFromWindowsHost.mockResolvedValue(failed);
    const res = await post('w1', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(failed);
  });

  it.each([
    ['a Linux agent', 'l1'],
    ['a macOS agent', 'm1'],
    ['an agent whose OS was never recorded (a Unix agent)', 'u1'],
    ['a server that is not an agent', 'loc'],
  ])('answers 501 unsupported_os with the reason and #499 for %s, and does nothing', async (_label, name) => {
    const res = await post(name, { removeMisao: false });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'unsupported_os', error: expect.stringContaining('#499') });
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
  });

  it('answers 404 for a server that does not exist', async () => {
    expect((await post('nope')).statusCode).toBe(404);
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
  });

  it('answers 400 for a body it does not know', async () => {
    expect((await post('w1', { removeMisao: 'yes' })).statusCode).toBe(400);
    expect((await post('w1', { removeMisao: true, removeHarness: true })).statusCode).toBe(400);
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
  });

  it('answers 400 when the server has no SSH host or address to reach it by', async () => {
    servers.w1 = server({ sshHost: undefined, host: undefined });
    const res = await post('w1', {});
    expect(res.statusCode).toBe(400);
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
  });

  it.each([
    ['a task principal', { class: 'task', id: 'task-1' } as unknown as Principal],
    ['no principal', undefined],
  ])('is operator-only (compat mode too): %s gets 403 and nothing happens', async (_label, who) => {
    principal = who;
    const res = await post('w1', {});
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'operator_required', operation: 'servers.agent_uninstall' });
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
  });

  it('runs inside the server\'s lock and reads the server again there', async () => {
    let release!: () => void;
    const held = mutex.withLock('w1', () => new Promise<void>((resolve) => { release = resolve; }));
    const pending = post('w1', {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
    // The server became a Linux one (re-registered) while the request waited: what is registered when the lock is held decides.
    servers.w1 = server({ hostProfile: { platform: 'linux', arch: 'x64' } });
    release();
    await held;
    const res = await pending;
    expect(res.statusCode).toBe(501);
    expect(uninstallFromWindowsHost).not.toHaveBeenCalled();
  });

  it('lets an error of the host (unreachable) through as an error, with nothing reported done', async () => {
    uninstallFromWindowsHost.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const res = await post('w1', {});
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ message: expect.stringContaining('ETIMEDOUT') });
  });
});
