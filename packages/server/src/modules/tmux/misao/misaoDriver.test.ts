import { describe, expect, it, vi } from 'vitest';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { MisaoMuxClient } from './MisaoMuxClient';
import { registerMisaoDriver, resolveMisaoRuntime, selectLocalMisaoServers, type MisaoRuntime } from './misaoDriver';

function runtime(connect: () => Promise<void>): MisaoRuntime {
  class FakeConnectionError extends Error {}
  const sdk = {
    MisaoClient: function MisaoClient() {
      const listeners: Array<(s: { status: 'connected' }) => void> = [];
      return {
        onStateChange: (cb: (s: { status: 'connected' }) => void) => { listeners.push(cb); },
        onGap: () => {},
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
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    const { connection } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() });
    const local = { muxRuntime: 'misao' as const, type: 'local' as const };

    expect(registry.availability(local)).toEqual({ available: false, reason: 'daemon_unreachable' });
    expect(() => registry.resolve(local)).toThrow(MuxDriverUnavailableError);

    await connection.start();
    expect(registry.availability(local)).toEqual({ available: true });
    expect(registry.resolve(local)).toBeInstanceOf(MisaoMuxClient);
    connection.close();
  });

  it('reports remote_unsupported for non-local servers regardless of the daemon', async () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    const { connection } = registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() });
    await connection.start();
    expect(registry.availability({ muxRuntime: 'misao', type: 'agent' })).toEqual({ available: false, reason: 'remote_unsupported' });
    connection.close();
  });

  it('stays disabled when the registry flag is off, whatever is registered', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: false });
    registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() });
    expect(registry.availability({ muxRuntime: 'misao', type: 'local' })).toEqual({ available: false, reason: 'misao_disabled' });
  });

  it('does not touch tmux servers', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registerMisaoDriver(registry, runtime(async () => {}), vi.fn(), { warn: vi.fn() });
    expect(registry.availability({ muxRuntime: 'system', type: 'local' })).toEqual({ available: false, reason: 'driver_not_registered' });
  });
});

describe('selectLocalMisaoServers', () => {
  it('keeps only local servers on the misao mux', () => {
    const servers = [
      { name: 'a', type: 'local', muxRuntime: 'misao' },
      { name: 'b', type: 'local', muxRuntime: 'system' },
      { name: 'c', type: 'local', muxRuntime: 'managed' },
      { name: 'd', type: 'agent', muxRuntime: 'misao' },
    ] as const;
    expect(selectLocalMisaoServers([...servers]).map((s) => s.name)).toEqual(['a']);
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
