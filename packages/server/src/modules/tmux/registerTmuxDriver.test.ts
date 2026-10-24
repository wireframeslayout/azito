import { describe, it, expect } from 'vitest';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import { registerTmuxDriver } from './registerTmuxDriver';
import type { IMuxClient } from './IMuxClient';

const driver = (kind: 'tmux' | 'misao') => ({ kind, caps: {} }) as unknown as IMuxClient;
const win32Local = { type: 'local' as const, name: 'local', hostProfile: { platform: 'win32' as const, arch: 'x64' as const } };
const linuxLocal = { type: 'local' as const, name: 'local', hostProfile: { platform: 'linux' as const, arch: 'x64' as const } };

function registryWithBoth(): MuxDriverRegistry {
  const registry = new MuxDriverRegistry();
  registerTmuxDriver(registry, driver('tmux'));
  registry.register('misao', driver('misao'));
  return registry;
}

describe('registerTmuxDriver', () => {
  it('lists and serves tmux beside misao on a Unix host, as before', () => {
    const registry = registryWithBoth();
    expect(registry.supportedKinds({ defaultMux: 'misao', ...linuxLocal })).toEqual(['misao', 'tmux']);
    expect(registry.availabilityFor('tmux', linuxLocal)).toEqual({ available: true });
  });

  it('does not list tmux on a Windows host and answers unsupported_os when it is asked for', () => {
    const registry = registryWithBoth();
    expect(registry.supportedKinds({ defaultMux: 'misao', ...win32Local })).toEqual(['misao']);
    expect(registry.usableKinds({ defaultMux: 'misao', ...win32Local })).toEqual(['misao']);
    expect(registry.availabilityFor('tmux', win32Local)).toEqual({ available: false, reason: 'unsupported_os' });
    expect(() => registry.resolveKind('tmux', win32Local)).toThrowError(expect.objectContaining({ reason: 'unsupported_os' }));
    expect(() => registry.resolveKind('tmux', win32Local)).toThrow(MuxDriverUnavailableError);
  });

  it('leaves a probe target that names no host (a bare kind) as available', () => {
    expect(registryWithBoth().availabilityFor('tmux', {})).toEqual({ available: true });
  });
});
