import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_PRINCIPAL, type Principal } from '../../../shared/auth/Principal';
import type { ServerConfig } from '../../servers/Server';
import { KeyedMutex } from '../../../shared/keyedMutex';
import agentMisaoRoutes from './agentMisaoRoutes';
import { MisaoServiceError } from './MisaoServiceError';

const agent = { name: 'a1', type: 'agent', host: 'h', agentPort: 3002, agentToken: 't' } as ServerConfig;
const local = { name: 'l1', type: 'local' } as ServerConfig;
const RESULT = { version: '0.2.0', runningVersion: '0.2.0', startMethod: 'systemd', updateAvailable: false };

describe('POST /api/servers/:name/install-misao', () => {
  let app: FastifyInstance;
  let principal: Principal | undefined;
  const install = vi.fn();
  const connection = { availability: vi.fn(), request: vi.fn() };
  const ensureAgentNode = vi.fn();
  const onInstalled = vi.fn();
  const getAgentTransport = vi.fn();

  beforeEach(async () => {
    principal = OPERATOR_PRINCIPAL;
    install.mockReset().mockImplementation(async (_transport: unknown, onProgress: (m: string) => void) => { onProgress('Transferring misao'); return RESULT; });
    connection.availability.mockReset().mockReturnValue({ available: true });
    connection.request.mockReset().mockResolvedValue({ protocolVersion: '0.3.0', version: '0.2.0' });
    ensureAgentNode.mockReset().mockReturnValue({ connection });
    onInstalled.mockReset();
    getAgentTransport.mockReset().mockReturnValue({ kind: 'transport' });
    app = Fastify();
    app.addHook('onRequest', async (request) => { request.principal = principal; });
    await app.register(agentMisaoRoutes, {
      serverRepo: { findByName: (name: string) => ({ a1: agent, l1: local } as Record<string, ServerConfig>)[name] ?? null },
      transportFactory: { getAgentTransport } as never,
      installer: { install } as never,
      misaoServers: { ensureAgentNode } as never,
      serverIsolationMutex: new KeyedMutex(),
      onInstalled,
      connectTimeoutMs: 200,
    });
  });
  afterEach(async () => { await app.close(); });

  const post = (name: string) => app.inject({ method: 'POST', url: `/api/servers/${name}/install-misao` });

  it('installs through the agent of the server, connects the hub to it and reports the daemon', async () => {
    const res = await post('a1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ...RESULT, steps: ['Transferring misao'], daemon: { installed: true, version: '0.3.0', daemonVersion: '0.2.0' } });
    expect(getAgentTransport).toHaveBeenCalledWith(agent);
    expect(install).toHaveBeenCalledWith({ kind: 'transport' }, expect.any(Function));
    expect(ensureAgentNode).toHaveBeenCalledWith(agent);
    expect(onInstalled).toHaveBeenCalledWith(agent);
  });

  it('answers with the daemon state it has when the connection is not up within the wait', async () => {
    connection.availability.mockReturnValue({ available: false, reason: 'daemon_unreachable' });
    const res = await post('a1');
    expect(res.statusCode).toBe(200);
    expect(res.json().daemon).toEqual({ installed: false, detail: 'daemon_unreachable' });
  });

  it.each([
    ['a task principal', { class: 'task', id: 'task-1' } as unknown as Principal],
    ['no principal', undefined],
  ])('refuses %s, in compat mode too, without touching the agent', async (_label, who) => {
    principal = who;
    const res = await post('a1');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'operator_required', operation: 'servers.install_misao' });
    expect(install).not.toHaveBeenCalled();
    expect(ensureAgentNode).not.toHaveBeenCalled();
  });

  it('is 404 for an unknown server and 400 for a local one, which has its own service', async () => {
    expect((await post('nope')).statusCode).toBe(404);
    const res = await post('l1');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('usage');
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported_host', 409],
    ['custom_socket', 409],
    ['not_managed', 409],
    ['transfer_failed', 502],
    ['daemon_not_ready', 502],
  ] as const)('maps a %s refusal to HTTP %i with its message and the steps taken so far', async (code, status) => {
    install.mockImplementationOnce(async (_t: unknown, onProgress: (m: string) => void) => { onProgress('Transferring misao'); throw new MisaoServiceError(code, `refused: ${code}`); });
    const res = await post('a1');
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: `refused: ${code}`, code, steps: ['Transferring misao'] });
    expect(ensureAgentNode).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('serializes two installs on the same server', async () => {
    let release!: () => void;
    install.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(RESULT); }));
    const first = post('a1');
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    const second = post('a1');
    await new Promise((r) => setTimeout(r, 30));
    expect(install).toHaveBeenCalledTimes(1);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(install).toHaveBeenCalledTimes(2);
  });
});
