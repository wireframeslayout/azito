import os from 'os';
import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { TransportFactory } from './TransportFactory';
import { AgentTransport } from './AgentTransport';
import { LocalTransport } from './LocalTransport';
import { HostProfileError, resolveHubHostProfile } from '../../../shared/os/hostProfile';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { testLocalHost } from '../../../shared/os/testing/testLocalHost';

describe('TransportFactory', () => {
  const baseServer = {
    name: 'server007',
    type: 'agent' as const,
    host: '10.0.0.7',
    hostProfile: null,
    agentPort: 4021,
    agentToken: 'tok-1',
    defaultMux: 'tmux' as const, muxRuntime: 'system' as const,
  };

  it('returns cached transport when token and muxRuntime match', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport(baseServer);
    expect(t1).toBe(t2);
  });

  it('recreates transport when agentToken changes', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport({ ...baseServer, agentToken: 'tok-2' });
    expect(t1).not.toBe(t2);
    expect(t2).toBeInstanceOf(AgentTransport);
  });

  it('recreates transport when muxRuntime changes', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport({ ...baseServer, muxRuntime: 'managed' });
    expect(t1).not.toBe(t2);
    expect(t2).toBeInstanceOf(AgentTransport);
  });

  it('gives a local server the tmux LocalTransport whichever mux it defaults to', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    const local = { name: 'local', type: 'local' as const, host: null, hostProfile: null, agentPort: null, agentToken: null, muxRuntime: 'system' as const };
    expect(factory.getTransport(local)).toBeInstanceOf(LocalTransport);
    expect(factory.getTransport({ ...local, defaultMux: 'misao' } as never)).toBeInstanceOf(LocalTransport);
  });

  it('invalidate forces recreation on next getTransport', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    const t1 = factory.getTransport(baseServer);
    factory.invalidate('server007');
    const t2 = factory.getTransport(baseServer);
    expect(t1).not.toBe(t2);
  });

  it('gives a local server the hub\'s own profile from its HostEnv, whatever the row holds', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'darwin', arch: 'arm64' });
    const local = { name: 'local', type: 'local' as const, host: null, hostProfile: { platform: 'win32' as const, arch: 'x64' as const }, agentPort: null, agentToken: null, muxRuntime: 'system' as const };
    expect(factory.hostProfileFor(local)).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(factory.getTransport(local).hostProfile).toEqual({ platform: 'darwin', arch: 'arm64' });
  });

  it('gives an agent server its recorded profile, or null when none is recorded', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    expect(factory.getTransport(baseServer).hostProfile).toBeNull();
    const recorded = { ...baseServer, name: 'win', hostProfile: { platform: 'win32' as const, arch: 'x64' as const } };
    expect(factory.getTransport(recorded).hostProfile).toEqual({ platform: 'win32', arch: 'x64' });
  });

  it('recreates an agent transport when its recorded profile changes', () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
    const t1 = factory.getTransport(baseServer);
    const t2 = factory.getTransport({ ...baseServer, hostProfile: { platform: 'linux', arch: 'x64' } });
    expect(t2).not.toBe(t1);
    expect(factory.getTransport({ ...baseServer, hostProfile: { platform: 'linux', arch: 'x64' } })).toBe(t2);
  });

  it('still gives a local transport on a hub whose OS is not supported: its profile is unknown (null), treated as POSIX', async () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), resolveHubHostProfile({ platform: 'freebsd', arch: 'x64' }));
    const local = { name: 'local', type: 'local' as const, host: null, hostProfile: null, agentPort: null, agentToken: null, muxRuntime: 'system' as const };
    const transport = factory.getTransport(local);
    expect(transport).toBeInstanceOf(LocalTransport);
    expect(transport.hostProfile).toBeNull();
    // Listing servers must not fail because of it: the hub's host is just unknown.
    expect(factory.hostProfileFor(local)).toBeNull();
  });

  it("keeps the hub's own sh and tmux operations reachable on linux/arm (a source-checkout hub AZITO has no profile for)", async () => {
    const factory = new TransportFactory('http://hub:3001', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), resolveHubHostProfile({ platform: 'linux', arch: 'arm' }));
    const transport = factory.getTransport({ name: 'local', type: 'local' as const, host: null, hostProfile: null, agentPort: null, agentToken: null, muxRuntime: 'system' as const });
    if (process.platform !== 'win32') expect((await transport.exec('echo hi')).stdout.trim()).toBe('hi');
    // The tmux binary may be absent here; what matters is that the call reaches it instead of being refused for the host.
    const outcome = await transport.execMux({ kind: 'tmux', args: ['-V'] }).then(() => null, (err: unknown) => err);
    expect(outcome).not.toBeInstanceOf(HostProfileError);
  });
});
