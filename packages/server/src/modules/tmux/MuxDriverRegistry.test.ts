import { describe, it, expect } from 'vitest';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import type { IMuxClient } from './IMuxClient';
import type { MuxRuntime } from '@azito/shared';

function makeMockDriver(kind: 'tmux' | 'herdr' | 'zellij'): IMuxClient {
  return { kind, caps: {} } as unknown as IMuxClient;
}

function serverWith(muxRuntime: MuxRuntime) {
  return { muxRuntime };
}

describe('MuxDriverRegistry', () => {
  it('resolve returns the registered driver for tmux (system)', () => {
    const registry = new MuxDriverRegistry();
    const driver = makeMockDriver('tmux');
    registry.register('tmux', driver);
    expect(registry.resolve(serverWith('system'))).toBe(driver);
  });

  it('resolve returns the registered driver for tmux (managed)', () => {
    const registry = new MuxDriverRegistry();
    const driver = makeMockDriver('tmux');
    registry.register('tmux', driver);
    expect(registry.resolve(serverWith('managed'))).toBe(driver);
  });

  it('resolve throws MuxDriverUnavailableError for unregistered kind', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', makeMockDriver('tmux'));
    expect(() => registry.resolve(serverWith('herdr'))).toThrow(MuxDriverUnavailableError);
    try {
      registry.resolve(serverWith('herdr'));
    } catch (err) {
      expect((err as MuxDriverUnavailableError).kind).toBe('herdr');
    }
  });

  it('resolve throws for zellij when not registered', () => {
    const registry = new MuxDriverRegistry();
    expect(() => registry.resolve(serverWith('zellij'))).toThrow(MuxDriverUnavailableError);
  });

  it('has returns true for registered kind', () => {
    const registry = new MuxDriverRegistry();
    registry.register('tmux', makeMockDriver('tmux'));
    expect(registry.has('tmux')).toBe(true);
  });

  it('has returns false for unregistered kind', () => {
    const registry = new MuxDriverRegistry();
    expect(registry.has('herdr')).toBe(false);
  });

  it('register overwrites a previous driver for the same kind', () => {
    const registry = new MuxDriverRegistry();
    const first = makeMockDriver('tmux');
    const second = makeMockDriver('tmux');
    registry.register('tmux', first);
    registry.register('tmux', second);
    expect(registry.resolve(serverWith('system'))).toBe(second);
  });
});
