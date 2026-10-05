import { describe, expect, it, vi } from 'vitest';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { describeMisaoDaemon, registerMisaoDriver, resolveMisaoRuntime, resolveMisaoRuntimeForHub, syncMisaoNodes, NO_AGENT_MISAO, type MisaoHandle, type MisaoRuntime } from './misaoDriver';

function runtime(connect: () => Promise<void>): MisaoRuntime {
  class FakeConnectionError extends Error {}
  const sdk = {
    MisaoClient: function MisaoClient() {
      const listeners: Array<(s: { status: 'connected' }) => void> = [];
      return {
        onStateChange: (cb: (s: { status: 'connected' }) => void) => { listeners.push(cb); },
        onGap: () => {},
        onEventsRecovered: () => () => {},
        onSubscriptionError: () => {},
        onError: () => {},
        connect: async () => { await connect(); for (const l of listeners) l({ status: 'connected' }); },
        close: () => {},
      };
    },
    MisaoConnectionError: FakeConnectionError,
    MisaoRpcError: class extends Error {},
    DEFAULT_BACKOFF: { initialDelayMs: 100, maxDelayMs: 5000, factor: 2 },
    computeBackoffDelay: () => 100,
  };
  return { sdk: sdk as never, socketPath: '/tmp/x.sock', shell: '/bin/bash' };
}

describe('registerMisaoDriver', () => {
  it('registers a misao driver whose availability follows the daemon connection', async () => {
    const registry = new MuxDriverRegistry();
    const { connection, driver } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' }, NO_AGENT_MISAO);
    const local = { defaultMux: 'misao' as const, muxRuntime: 'system' as const, type: 'local' as const };

    expect(registry.availability(local)).toEqual({ available: false, reason: 'daemon_unreachable' });
    expect(() => registry.resolve(local)).toThrow(MuxDriverUnavailableError);

    await connection.start();
    expect(registry.availability(local)).toEqual({ available: true });
    expect(registry.resolve(local).caps).toBe(driver.caps);
    connection.close();
  });

  it('reports not_installed for an agent server that has no misao node, whatever the local daemon does', async () => {
    const registry = new MuxDriverRegistry();
    const { connection } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' }, NO_AGENT_MISAO);
    await connection.start();
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'agent', name: 'a1' })).toEqual({ available: false, reason: 'not_installed' });
    connection.close();
  });

  it('lists misao on an agent server only once it has a node, and on a local server always', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', { kind: 'tmux' } as never);
    const { servers, connection } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' }, {
      target: () => ({ connect: async () => { throw new Error('no relay in this test'); } }),
      status: async () => ({ socketPath: '/x', socketPresent: true }),
    });
    const agent = { name: 'a1', type: 'agent' as const, defaultMux: 'tmux' as const, host: 'h', agentPort: 1, agentToken: 't' } as never;
    expect(registry.supportedKinds({ defaultMux: 'tmux', type: 'local', name: 'l' })).toEqual(['tmux', 'misao']);
    expect(registry.supportedKinds({ defaultMux: 'tmux', type: 'agent', name: 'a1' })).toEqual(['tmux']);
    expect(registry.downKinds({ defaultMux: 'tmux', type: 'agent', name: 'a1' })).toEqual([]);

    servers.ensureAgentNode(agent);
    expect(registry.supportedKinds({ defaultMux: 'tmux', type: 'agent', name: 'a1' })).toEqual(['tmux', 'misao']);
    expect(registry.supportedKinds({ defaultMux: 'misao', type: 'agent', name: 'a2' })).toEqual(['misao', 'tmux']);
    servers.discardAgentNode({ name: 'a1' });
    expect(registry.supportedKinds({ defaultMux: 'tmux', type: 'agent', name: 'a1' })).toEqual(['tmux']);
    connection.close();
  });

  it('reports daemon_unreachable, not a disabled driver, while no daemon is running', () => {
    const registry = new MuxDriverRegistry();
    registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' }, NO_AGENT_MISAO);
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'local' })).toEqual({ available: false, reason: 'daemon_unreachable' });
  });

  it('does not touch tmux servers', () => {
    const registry = new MuxDriverRegistry();
    registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' }, NO_AGENT_MISAO);
    expect(registry.availability({ defaultMux: 'tmux' as const, type: 'local' })).toEqual({ available: false, reason: 'driver_not_registered' });
  });
});

describe('resolveMisaoRuntimeForHub', () => {
  const input = { env: { MISAO_SOCKET: `/tmp/${'a'.repeat(120)}.sock` }, homeDir: '/home/x', shell: '/bin/bash' };

  it('keeps a usable socket as is', async () => {
    const warn = vi.fn();
    const resolved = await resolveMisaoRuntimeForHub({ ...input, env: { MISAO_SOCKET: '/tmp/ok.sock' } }, true, { warn });
    expect(resolved.socketPath).toBe('/tmp/ok.sock');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and leaves the driver unreachable when no misao server needs it', async () => {
    const warn = vi.fn();
    const resolved = await resolveMisaoRuntimeForHub(input, false, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const registry = new MuxDriverRegistry();
    const { connection } = registerMisaoDriver(registry, resolved, vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://h', localUrl: 'http://l', webhookToken: 'w' }, NO_AGENT_MISAO);
    expect(registry.availability({ defaultMux: 'misao', type: 'local' })).toEqual({ available: false, reason: 'daemon_unreachable' });
    connection.close();
  });

  it('fails fast when a misao server exists', async () => {
    await expect(resolveMisaoRuntimeForHub(input, true, { warn: vi.fn() })).rejects.toThrow();
  });
});

describe('resolveMisaoRuntime', () => {
  it('loads the ESM SDK and resolves the socket from the environment given', async () => {
    const resolved = await resolveMisaoRuntime({ env: { MISAO_SOCKET: '/tmp/claude-1000/azm.sock' }, homeDir: '/home/x', shell: '/bin/zsh' });
    expect(resolved.socketPath).toBe('/tmp/claude-1000/azm.sock');
    expect(resolved.shell).toBe('/bin/zsh');
    expect(typeof resolved.sdk.MisaoClient).toBe('function');
  });

  it('falls back to the default socket under the home directory', async () => {
    const resolved = await resolveMisaoRuntime({ env: {}, homeDir: '/home/x', shell: '/bin/bash' });
    expect(resolved.socketPath).toBe('/home/x/.misao/misao.sock');
  });

  it('rejects a socket path the OS cannot bind', async () => {
    await expect(resolveMisaoRuntime({ env: { MISAO_SOCKET: `/tmp/${'a'.repeat(120)}.sock` }, homeDir: '/home/x', shell: '/bin/bash' })).rejects.toThrow();
  });
});

describe('syncMisaoNodes', () => {
  const srv = (type: 'local' | 'agent', defaultMux: 'tmux' | 'misao' = 'tmux') => ({ name: 's', type, defaultMux, muxRuntime: 'system' }) as never;
  const handle = () => {
    const driver = { installChangeHooks: vi.fn(async () => {}), uninstallChangeHooks: vi.fn(async () => {}) };
    const servers = { discardAgentNode: vi.fn(), ensureAgentNode: vi.fn() };
    return { misao: { driver, servers } as unknown as MisaoHandle, driver, servers };
  };
  const log = { warn: vi.fn() };

  it('installs the local change events when a server becomes local (agent to local) and drops its agent node', () => {
    const { misao, driver, servers } = handle();
    syncMisaoNodes(misao, srv('agent'), srv('local'), false, log);
    expect(servers.discardAgentNode).toHaveBeenCalledTimes(1);
    expect(driver.installChangeHooks).toHaveBeenCalledTimes(1);
    expect(servers.ensureAgentNode).not.toHaveBeenCalled();
  });

  it('uninstalls the local change events when a server becomes an agent (local to agent), and makes its node when it uses misao', () => {
    const { misao, driver, servers } = handle();
    syncMisaoNodes(misao, srv('local'), srv('agent'), true, log);
    expect(driver.uninstallChangeHooks).toHaveBeenCalledTimes(1);
    expect(servers.ensureAgentNode).toHaveBeenCalledTimes(1);
    expect(driver.installChangeHooks).not.toHaveBeenCalled();
  });

  it('replaces the node of an agent server that is edited and still uses misao', () => {
    const { misao, servers } = handle();
    syncMisaoNodes(misao, srv('agent'), srv('agent'), true, log);
    expect(servers.discardAgentNode).toHaveBeenCalledTimes(1);
    expect(servers.ensureAgentNode).toHaveBeenCalledTimes(1);
  });

  it('only drops the node of an agent server that no longer uses misao', () => {
    const { misao, servers } = handle();
    syncMisaoNodes(misao, srv('agent'), srv('agent'), false, log);
    expect(servers.discardAgentNode).toHaveBeenCalledTimes(1);
    expect(servers.ensureAgentNode).not.toHaveBeenCalled();
  });

  it('does nothing for a local server whose default mux changes: both muxes stay usable', () => {
    const { misao, driver, servers } = handle();
    syncMisaoNodes(misao, srv('local', 'tmux'), srv('local', 'misao'), false, log);
    expect(driver.installChangeHooks).not.toHaveBeenCalled();
    expect(driver.uninstallChangeHooks).not.toHaveBeenCalled();
    expect(servers.discardAgentNode).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the daemon is unreachable', async () => {
    const { misao, driver } = handle();
    driver.installChangeHooks.mockRejectedValueOnce(new Error('down'));
    syncMisaoNodes(misao, srv('agent'), srv('local'), false, log);
    await new Promise((r) => setImmediate(r));
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('describeMisaoDaemon', () => {
  function connection(availability: { available: true } | { available: false; reason: string }, request: () => Promise<unknown>) {
    return { availability: () => availability, request } as never;
  }

  it('reports the protocol version of a connected daemon', async () => {
    const request = vi.fn(async () => ({ protocolVersion: '0.2.0' }));
    const status = await describeMisaoDaemon(connection({ available: true }, request));
    expect(status).toEqual({ installed: true, version: '0.2.0' });
    expect(request).toHaveBeenCalledWith('server.info', {});
  });

  it('adds the release version of a daemon that reports one', async () => {
    const status = await describeMisaoDaemon(connection({ available: true }, async () => ({ protocolVersion: '0.3.0', version: '0.2.0' })));
    expect(status).toEqual({ installed: true, version: '0.3.0', daemonVersion: '0.2.0' });
  });

  it('reports an unreachable daemon without sending a request', async () => {
    const request = vi.fn();
    const status = await describeMisaoDaemon(connection({ available: false, reason: 'daemon_unreachable' }, request));
    expect(status).toEqual({ installed: false, detail: 'daemon_unreachable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('puts the error message in detail when server.info fails', async () => {
    const status = await describeMisaoDaemon(connection({ available: true }, async () => { throw new Error('socket closed'); }));
    expect(status).toEqual({ installed: false, detail: 'socket closed' });
  });

  it('puts the reason, not the English message, in detail when the driver becomes unavailable mid-request', async () => {
    const status = await describeMisaoDaemon(connection({ available: true }, async () => { throw new MuxDriverUnavailableError('misao', 'daemon_unreachable'); }));
    expect(status).toEqual({ installed: false, detail: 'daemon_unreachable' });
  });
});
