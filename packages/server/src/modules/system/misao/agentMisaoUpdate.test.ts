import { describe, expect, it } from 'vitest';
import { agentMisaoUpdateAvailable } from './agentMisaoUpdate';

describe('agentMisaoUpdateAvailable', () => {
  const bundledVersion = '0.3.0';

  it.each([
    ['the daemon reports another release', { daemon: { daemonVersion: '0.2.0' } }],
    ['the daemon cannot be connected to (protocol mismatch)', { daemon: { detail: 'protocol_incompatible' } }],
    ['the daemon is unreachable and reports nothing, but the managed layout holds an older release', { daemon: { detail: 'daemon_unreachable' }, installedVersion: '0.2.0' }],
    ['the daemon answers without a version, and the layout holds an older release', { daemon: {}, installedVersion: '0.2.0' }],
    ['there is no daemon connection at all, and the layout holds an older release', { installedVersion: '0.2.0' }],
  ])('is true when %s', (_label, input) => {
    expect(agentMisaoUpdateAvailable({ bundledVersion, ...input })).toBe(true);
  });

  it.each([
    ['the daemon and the layout are the bundled release', { daemon: { daemonVersion: '0.3.0' }, installedVersion: '0.3.0' }],
    ['nothing is installed', {}],
    ['the daemon is unreachable and the layout is the bundled release', { daemon: { detail: 'daemon_unreachable' }, installedVersion: '0.3.0' }],
  ])('is false when %s', (_label, input) => {
    expect(agentMisaoUpdateAvailable({ bundledVersion, ...input })).toBe(false);
  });

  it('is false when this hub bundles no misao (there is nothing to update to)', () => {
    expect(agentMisaoUpdateAvailable({ bundledVersion: undefined, daemon: { daemonVersion: '0.2.0' }, installedVersion: '0.2.0' })).toBe(false);
  });
});
