import { describe, it, expect, vi } from 'vitest';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import type { IMuxClient } from './IMuxClient';

const driver = (kind: 'tmux' | 'misao') => ({ kind, caps: {} }) as unknown as IMuxClient;

describe('MuxDriverRegistry (misao)', () => {
  it('reports misao_disabled when the flag is off', () => {
    const registry = new MuxDriverRegistry();
    expect(registry.availability({ muxRuntime: 'misao' })).toEqual({ available: false, reason: 'misao_disabled' });
    expect(() => registry.resolve({ muxRuntime: 'misao' })).toThrow(MuxDriverUnavailableError);
  });

  it('prefers misao_disabled even when a misao driver is registered', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: false });
    registry.register('misao', driver('misao'));
    expect(registry.availability({ muxRuntime: 'misao' })).toEqual({ available: false, reason: 'misao_disabled' });
  });

  it('reports driver_not_registered when the flag is on but no driver exists', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    expect(registry.availability({ muxRuntime: 'misao' })).toEqual({ available: false, reason: 'driver_not_registered' });
    try {
      registry.resolve({ muxRuntime: 'misao' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MuxDriverUnavailableError);
      expect((err as MuxDriverUnavailableError).kind).toBe('misao');
      expect((err as MuxDriverUnavailableError).reason).toBe('driver_not_registered');
    }
  });

  it('resolves a registered misao driver when the flag is on', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    const misao = driver('misao');
    registry.register('misao', misao);
    expect(registry.resolve({ muxRuntime: 'misao' })).toBe(misao);
  });

  it('never resolves a tmux server to the misao driver and vice versa', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('tmux', driver('tmux'));
    expect(registry.availability({ muxRuntime: 'system' })).toEqual({ available: true });
    expect(registry.availability({ muxRuntime: 'misao' })).toEqual({ available: false, reason: 'driver_not_registered' });
  });
});

describe('MuxDriverRegistry (driver probe)', () => {
  it('evaluates the probe after the flag and registration checks', () => {
    const probe = vi.fn(() => ({ available: false, reason: 'daemon_unreachable' }) as const);

    const disabled = new MuxDriverRegistry({ misaoEnabled: false });
    disabled.register('misao', driver('misao'), probe);
    expect(disabled.availability({ muxRuntime: 'misao' })).toEqual({ available: false, reason: 'misao_disabled' });
    expect(probe).not.toHaveBeenCalled();

    const unregistered = new MuxDriverRegistry({ misaoEnabled: true });
    expect(unregistered.availability({ muxRuntime: 'misao' })).toEqual({ available: false, reason: 'driver_not_registered' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports the probe verdict and throws it from resolve', () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', driver('misao'), (server) => (server.type === 'local' ? { available: true } : { available: false, reason: 'remote_unsupported' }));
    expect(registry.availability({ muxRuntime: 'misao', type: 'local' })).toEqual({ available: true });
    expect(registry.availability({ muxRuntime: 'misao', type: 'agent' })).toEqual({ available: false, reason: 'remote_unsupported' });
    try {
      registry.resolve({ muxRuntime: 'misao', type: 'agent' });
      expect.unreachable();
    } catch (err) {
      expect((err as MuxDriverUnavailableError).reason).toBe('remote_unsupported');
    }
  });

  it('reports daemon_unreachable from a probe that tracks connection state', () => {
    let connected = false;
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    const misao = driver('misao');
    registry.register('misao', misao, () => (connected ? { available: true } : { available: false, reason: 'daemon_unreachable' }));
    expect(registry.availability({ muxRuntime: 'misao', type: 'local' })).toEqual({ available: false, reason: 'daemon_unreachable' });
    connected = true;
    expect(registry.resolve({ muxRuntime: 'misao', type: 'local' })).toBe(misao);
  });

  it('does not evaluate a probe for tmux servers', () => {
    const probe = vi.fn(() => ({ available: false, reason: 'daemon_unreachable' }) as const);
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('tmux', driver('tmux'));
    registry.register('misao', driver('misao'), probe);
    expect(registry.availability({ muxRuntime: 'system', type: 'local' })).toEqual({ available: true });
    expect(probe).not.toHaveBeenCalled();
  });
});
