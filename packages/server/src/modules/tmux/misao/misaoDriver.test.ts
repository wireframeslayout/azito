import { describe, expect, it, vi } from 'vitest';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { MisaoMuxClient } from './MisaoMuxClient';
import { describeMisaoDaemon, registerMisaoDriver, resolveMisaoRuntime, resolveMisaoRuntimeForHub, selectLocalMisaoServers, syncMisaoChangeHooks, type MisaoHandle, type MisaoRuntime } from './misaoDriver';

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
    const { connection } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' });
    const local = { defaultMux: 'misao' as const, muxRuntime: 'system' as const, type: 'local' as const };

    expect(registry.availability(local)).toEqual({ available: false, reason: 'daemon_unreachable' });
    expect(() => registry.resolve(local)).toThrow(MuxDriverUnavailableError);

    await connection.start();
    expect(registry.availability(local)).toEqual({ available: true });
    expect(registry.resolve(local)).toBeInstanceOf(MisaoMuxClient);
    connection.close();
  });

  it('reports remote_unsupported for non-local servers regardless of the daemon', async () => {
    const registry = new MuxDriverRegistry();
    const { connection } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' });
    await connection.start();
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'agent' })).toEqual({ available: false, reason: 'remote_unsupported' });
    connection.close();
  });

  it('reports daemon_unreachable, not a disabled driver, while no daemon is running', () => {
    const registry = new MuxDriverRegistry();
    registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' });
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'local' })).toEqual({ available: false, reason: 'daemon_unreachable' });
  });

  it('does not touch tmux servers', () => {
    const registry = new MuxDriverRegistry();
    registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' });
    expect(registry.availability({ defaultMux: 'tmux' as const, type: 'local' })).toEqual({ available: false, reason: 'driver_not_registered' });
  });
});

describe('selectLocalMisaoServers', () => {
  it('keeps only local servers on the misao mux', () => {
    const servers = [
      { name: 'a', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system' },
      { name: 'b', type: 'local', defaultMux: 'tmux' as const, muxRuntime: 'system' },
      { name: 'c', type: 'local', defaultMux: 'tmux' as const, muxRuntime: 'managed' },
      { name: 'd', type: 'agent', defaultMux: 'misao' as const, muxRuntime: 'system' },
    ] as const;
    expect(selectLocalMisaoServers([...servers]).map((s) => s.name)).toEqual(['a']);
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
    const { connection } = registerMisaoDriver(registry, resolved, vi.fn(), { warn: vi.fn() }, { publicUrl: 'http://h', localUrl: 'http://l', webhookToken: 'w' });
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

describe('syncMisaoChangeHooks', () => {
  const srv = (defaultMux: 'tmux' | 'misao', type: 'local' | 'agent' = 'local') => ({ name: 's', type, defaultMux, muxRuntime: 'system' }) as never;
  const handle = () => {
    const driver = { installChangeHooks: vi.fn(async () => {}), uninstallChangeHooks: vi.fn(async () => {}) };
    return { misao: { driver } as unknown as MisaoHandle, driver };
  };
  const log = { warn: vi.fn() };

  it('installs change events when a local server moves onto misao', () => {
    const { misao, driver } = handle();
    syncMisaoChangeHooks(misao, srv('tmux'), srv('misao'), log);
    expect(driver.installChangeHooks).toHaveBeenCalledTimes(1);
    expect(driver.uninstallChangeHooks).not.toHaveBeenCalled();
  });

  it('uninstalls change events when a server moves off misao', () => {
    const { misao, driver } = handle();
    syncMisaoChangeHooks(misao, srv('misao'), srv('tmux'), log);
    expect(driver.uninstallChangeHooks).toHaveBeenCalledTimes(1);
    expect(driver.installChangeHooks).not.toHaveBeenCalled();
  });

  it('does nothing for tmux-to-tmux switches', () => {
    const { misao, driver } = handle();
    syncMisaoChangeHooks(misao, srv('tmux'), srv('tmux'), log);
    expect(driver.installChangeHooks).not.toHaveBeenCalled();
    expect(driver.uninstallChangeHooks).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the daemon is unreachable', async () => {
    const { misao, driver } = handle();
    driver.installChangeHooks.mockRejectedValueOnce(new Error('down'));
    syncMisaoChangeHooks(misao, srv('tmux'), srv('misao'), log);
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
