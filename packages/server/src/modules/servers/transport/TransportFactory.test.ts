import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { TransportFactory } from './TransportFactory';
import { AgentTransport } from './AgentTransport';
import { LocalTransport } from './LocalTransport';

describe('TransportFactory', () => {
  const baseServer = {
    name: 'server007',
    type: 'agent' as const,
    host: '10.0.0.7',
    agentPort: 4021,
    agentToken: 'tok-1',
    defaultMux: 'tmux' as const, muxRuntime: 'system' as const,
  };

  it('returns cached transport when token and muxRuntime match', () => {
    const factory = new TransportFactory('http://hub:3001');
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport(baseServer);
    expect(t1).toBe(t2);
  });

  it('recreates transport when agentToken changes', () => {
    const factory = new TransportFactory('http://hub:3001');
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport({ ...baseServer, agentToken: 'tok-2' });
    expect(t1).not.toBe(t2);
    expect(t2).toBeInstanceOf(AgentTransport);
  });

  it('recreates transport when muxRuntime changes', () => {
    const factory = new TransportFactory('http://hub:3001');
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport({ ...baseServer, muxRuntime: 'managed' });
    expect(t1).not.toBe(t2);
    expect(t2).toBeInstanceOf(AgentTransport);
  });

  it('gives a local server the tmux LocalTransport whichever mux it defaults to', () => {
    const factory = new TransportFactory('http://hub:3001');
    const local = { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, muxRuntime: 'system' as const };
    expect(factory.getTransport(local)).toBeInstanceOf(LocalTransport);
    expect(factory.getTransport({ ...local, defaultMux: 'misao' } as never)).toBeInstanceOf(LocalTransport);
  });

  it('invalidate forces recreation on next getTransport', () => {
    const factory = new TransportFactory('http://hub:3001');
    const t1 = factory.getTransport(baseServer);
    factory.invalidate('server007');
    const t2 = factory.getTransport(baseServer);
    expect(t1).not.toBe(t2);
  });
});
