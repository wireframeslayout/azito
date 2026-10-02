import { describe, it, expect } from 'vitest';
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
