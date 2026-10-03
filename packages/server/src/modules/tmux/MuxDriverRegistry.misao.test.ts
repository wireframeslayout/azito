import { describe, it, expect, vi } from 'vitest';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import type { IMuxClient } from './IMuxClient';

const driver = (kind: 'tmux' | 'misao') => ({ kind, caps: {} }) as unknown as IMuxClient;

describe('MuxDriverRegistry (misao)', () => {
  it('reports driver_not_registered when no driver is registered', () => {
    const registry = new MuxDriverRegistry();
    expect(registry.availability({ defaultMux: 'misao' as const })).toEqual({ available: false, reason: 'driver_not_registered' });
    try {
      registry.resolve({ defaultMux: 'misao' as const });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MuxDriverUnavailableError);
      expect((err as MuxDriverUnavailableError).kind).toBe('misao');
      expect((err as MuxDriverUnavailableError).reason).toBe('driver_not_registered');
    }
  });

  it('resolves a registered misao driver', () => {
    const registry = new MuxDriverRegistry();
    const misao = driver('misao');
    registry.register('misao', misao);
    expect(registry.resolve({ defaultMux: 'misao' as const })).toBe(misao);
  });

  it('never resolves a tmux server to the misao driver and vice versa', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    expect(registry.availability({ defaultMux: 'tmux' as const })).toEqual({ available: true });
    expect(registry.availability({ defaultMux: 'misao' as const })).toEqual({ available: false, reason: 'driver_not_registered' });
  });
});

describe('MuxDriverRegistry (driver probe)', () => {
  it('skips the probe when no driver is registered', () => {
    const probe = vi.fn(() => ({ available: false, reason: 'daemon_unreachable' }) as const);

    const unregistered = new MuxDriverRegistry();
    expect(unregistered.availability({ defaultMux: 'misao' as const })).toEqual({ available: false, reason: 'driver_not_registered' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('resolveKind and availabilityFor pick the driver by kind, whatever the server default is', () => {
    const registry = new MuxDriverRegistry();
    const tmux = driver('tmux');
    const misao = driver('misao');
    registry.register('tmux', tmux);
    registry.register('misao', misao, (server) => (server.type === 'local' ? { available: true } : { available: false, reason: 'remote_unsupported' }));
    expect(registry.resolveKind('misao', { type: 'local' })).toBe(misao);
    expect(registry.resolveKind('tmux', { type: 'local' })).toBe(tmux);
    expect(registry.availabilityFor('misao', { type: 'agent' })).toEqual({ available: false, reason: 'remote_unsupported' });
    expect(() => registry.resolveKind('misao', { type: 'agent' })).toThrow(MuxDriverUnavailableError);
    expect(registry.resolve({ defaultMux: 'misao' as const, type: 'local' })).toBe(registry.resolveKind('misao', { type: 'local' }));
  });

  it('reports the probe verdict and throws it from resolve', () => {
    const registry = new MuxDriverRegistry();
    registry.register('misao', driver('misao'), (server) => (server.type === 'local' ? { available: true } : { available: false, reason: 'remote_unsupported' }));
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'local' })).toEqual({ available: true });
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'agent' })).toEqual({ available: false, reason: 'remote_unsupported' });
    try {
      registry.resolve({ defaultMux: 'misao' as const, type: 'agent' });
      expect.unreachable();
    } catch (err) {
      expect((err as MuxDriverUnavailableError).reason).toBe('remote_unsupported');
    }
  });

  it('reports daemon_unreachable from a probe that tracks connection state', () => {
    let connected = false;
    const registry = new MuxDriverRegistry();
    const misao = driver('misao');
    registry.register('misao', misao, () => (connected ? { available: true } : { available: false, reason: 'daemon_unreachable' }));
    expect(registry.availability({ defaultMux: 'misao' as const, type: 'local' })).toEqual({ available: false, reason: 'daemon_unreachable' });
    connected = true;
    expect(registry.resolve({ defaultMux: 'misao' as const, type: 'local' })).toBe(misao);
  });

  it('does not evaluate a probe for tmux servers', () => {
    const probe = vi.fn(() => ({ available: false, reason: 'daemon_unreachable' }) as const);
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    registry.register('misao', driver('misao'), probe);
    expect(registry.availability({ defaultMux: 'tmux' as const, type: 'local' })).toEqual({ available: true });
    expect(probe).not.toHaveBeenCalled();
  });
});
