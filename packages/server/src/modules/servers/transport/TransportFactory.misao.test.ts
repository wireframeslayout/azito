import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { TransportFactory } from './TransportFactory';
import { MuxDriverUnavailableError } from '../../tmux/MuxCapabilityError';

const localMisao = { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, muxRuntime: 'misao' as const };

function thrownBy(fn: () => unknown): MuxDriverUnavailableError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MuxDriverUnavailableError);
    return err as MuxDriverUnavailableError;
  }
  throw new Error('expected getTransport to throw');
}

describe('TransportFactory (misao)', () => {
  it('fails with misao_disabled when the flag is off', () => {
    const err = thrownBy(() => new TransportFactory('http://hub:3001').getTransport(localMisao));
    expect(err.kind).toBe('misao');
    expect(err.reason).toBe('misao_disabled');
  });

  it('fails with driver_not_registered when the flag is on', () => {
    const err = thrownBy(() => new TransportFactory('http://hub:3001', { misaoEnabled: true }).getTransport(localMisao));
    expect(err.reason).toBe('driver_not_registered');
  });

  it('does not return a cached tmux transport once the server switches to misao', () => {
    const factory = new TransportFactory('http://hub:3001');
    factory.getTransport({ ...localMisao, muxRuntime: 'system' });
    expect(() => factory.getTransport(localMisao)).toThrow(MuxDriverUnavailableError);
  });

  it('keeps serving tmux servers unaffected', () => {
    const factory = new TransportFactory('http://hub:3001');
    expect(factory.getTransport({ ...localMisao, muxRuntime: 'system' })).toBeDefined();
  });
});
