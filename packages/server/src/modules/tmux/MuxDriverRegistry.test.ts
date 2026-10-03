import { describe, it, expect } from 'vitest';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import type { IMuxClient } from './IMuxClient';

function makeMockDriver(kind: 'tmux'): IMuxClient {
  return { kind, caps: {} } as unknown as IMuxClient;
}

function serverWith(defaultMux: 'tmux' | 'misao') {
  return { defaultMux };
}

describe('MuxDriverRegistry', () => {
  it('resolve returns the registered driver for tmux', () => {
    const registry = new MuxDriverRegistry();
    const driver = makeMockDriver('tmux');
    registry.register('tmux', driver);
    expect(registry.resolve(serverWith('tmux'))).toBe(driver);
  });

  it('resolve throws MuxDriverUnavailableError when no driver registered', () => {
    const registry = new MuxDriverRegistry();
    expect(() => registry.resolve(serverWith('tmux'))).toThrow(MuxDriverUnavailableError);
  });

  it('register overwrites a previous driver for the same kind', () => {
    const registry = new MuxDriverRegistry();
    const first = makeMockDriver('tmux');
    const second = makeMockDriver('tmux');
    registry.register('tmux', first);
    registry.register('tmux', second);
    expect(registry.resolve(serverWith('tmux'))).toBe(second);
  });

});
