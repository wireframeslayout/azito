import { describe, it, expect, vi } from 'vitest';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import type { IMuxClient } from './IMuxClient';

const driver = (kind: 'tmux' | 'misao') => ({ kind, caps: { copyMode: kind === 'tmux' } }) as unknown as IMuxClient;

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
    const routing = registry.resolve({ defaultMux: 'misao' as const });
    expect(routing.kind).toBe('misao');
    expect(routing.caps).toBe(misao.caps);
  });

  it('serves a misao-default server through tmux when only tmux is registered, and never the other way round', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    expect(registry.availability({ defaultMux: 'tmux' as const })).toEqual({ available: true });
    expect(registry.availabilityFor('misao', {})).toEqual({ available: false, reason: 'driver_not_registered' });
    expect(registry.usableKinds({ defaultMux: 'tmux' as const })).toEqual(['tmux']);
    expect(registry.usableKinds({ defaultMux: 'misao' as const })).toEqual(['misao', 'tmux']);
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
    expect(registry.resolve({ defaultMux: 'misao' as const, type: 'local' }).caps).toBe(misao.caps);
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
    expect(registry.resolve({ defaultMux: 'misao' as const, type: 'local' }).caps).toBe(misao.caps);
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

describe('MuxDriverRegistry (usable kinds)', () => {
  const probeOf = (connected: () => boolean) => (server: { type?: string }) => {
    if (server.type !== undefined && server.type !== 'local') return { available: false, reason: 'remote_unsupported' } as const;
    return connected() ? { available: true } as const : { available: false, reason: 'daemon_unreachable' } as const;
  };

  it('lists the default kind first and another kind only while it is available', () => {
    let connected = false;
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    registry.register('misao', driver('misao'), probeOf(() => connected));
    expect(registry.usableKinds({ defaultMux: 'tmux', type: 'local' })).toEqual(['tmux']);
    connected = true;
    expect(registry.usableKinds({ defaultMux: 'tmux', type: 'local' })).toEqual(['tmux', 'misao']);
    expect(registry.usableKinds({ defaultMux: 'misao', type: 'local' })).toEqual(['misao', 'tmux']);
  });

  it('keeps a hosted kind that is down in supportedKinds and reports it, with its reason, in downKinds', () => {
    let connected = false;
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    registry.register('misao', driver('misao'), probeOf(() => connected));
    const local = { defaultMux: 'tmux' as const, type: 'local' as const };
    expect(registry.supportedKinds(local)).toEqual(['tmux', 'misao']);
    expect(registry.downKinds(local)).toEqual([{ kind: 'misao', reason: 'daemon_unreachable' }]);
    connected = true;
    expect(registry.downKinds(local)).toEqual([]);
    expect(registry.supportedKinds({ defaultMux: 'tmux', type: 'agent' })).toEqual(['tmux']);
    expect(registry.downKinds({ defaultMux: 'tmux', type: 'agent' })).toEqual([]);
  });

  it('never lists misao for an agent or ssh server, whatever the daemon state', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    registry.register('misao', driver('misao'), probeOf(() => true));
    expect(registry.usableKinds({ defaultMux: 'tmux', type: 'agent' })).toEqual(['tmux']);
  });

  it('keeps the default kind listed when it is down, so its failure surfaces', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', driver('tmux'));
    registry.register('misao', driver('misao'), probeOf(() => false));
    expect(registry.usableKinds({ defaultMux: 'misao', type: 'local' })).toEqual(['misao', 'tmux']);
    expect(registry.availability({ defaultMux: 'misao', type: 'local' })).toEqual({ available: true });
  });
});
