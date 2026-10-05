import { describe, expect, it } from 'vitest';
import type { MisaoServiceStatus } from '@azito/shared';
import { misaoNotices, misaoServiceMode, misaoVersions, unmanagedReasonKey } from './misaoService';

function status(overrides: Partial<MisaoServiceStatus> = {}): MisaoServiceStatus {
  return {
    managed: true,
    serviceInstalled: true,
    serviceState: 'active',
    bundledVersion: '0.2.0',
    installedVersion: '0.2.0',
    daemon: { reachable: true, version: '0.2.0', protocolVersion: '0.3.0' },
    socketSetting: 'managed',
    needsHubRestart: false,
    updateAvailable: false,
    ...overrides,
  };
}

describe('misaoServiceMode', () => {
  it('is unmanaged whenever the hub cannot install misao, even if a daemon is running', () => {
    expect(misaoServiceMode(status({ managed: false, unmanagedReason: 'source_install', serviceInstalled: false }))).toBe('unmanaged');
  });

  it('tells a missing service from a stopped one from a running one', () => {
    expect(misaoServiceMode(status({ serviceInstalled: false, serviceState: undefined }))).toBe('not_installed');
    expect(misaoServiceMode(status({ serviceState: 'inactive' }))).toBe('stopped');
    expect(misaoServiceMode(status({ serviceState: 'failed' }))).toBe('stopped');
    expect(misaoServiceMode(status())).toBe('running');
  });
});

describe('misaoNotices', () => {
  it('has nothing to say about a current, running service', () => {
    expect(misaoNotices(status())).toEqual([]);
  });

  it('puts an incompatible protocol before everything and does not also offer the plain update notice', () => {
    expect(misaoNotices(status({ updateAvailable: true, daemon: { reachable: false, detail: 'protocol_incompatible' }, needsHubRestart: true })))
      .toEqual(['incompatible', 'needsHubRestart']);
  });

  it('asks for an update when the running daemon differs from the bundled release', () => {
    expect(misaoNotices(status({ updateAvailable: true, daemon: { reachable: true, version: '0.1.0' } }))).toEqual(['updateAvailable']);
  });

  it('warns that installing would replace a custom MISAO_SOCKET only while nothing is installed', () => {
    expect(misaoNotices(status({ serviceInstalled: false, serviceState: undefined, socketSetting: 'custom' }))).toEqual(['customSocket']);
    expect(misaoNotices(status({ socketSetting: 'custom' }))).toEqual([]);
  });

  it('adds no notice for an unmanaged hub', () => {
    expect(misaoNotices(status({ managed: false, updateAvailable: true, needsHubRestart: true }))).toEqual([]);
  });
});

describe('misaoVersions / unmanagedReasonKey', () => {
  it('prints only the versions that are known', () => {
    expect(misaoVersions(status())).toEqual({ bundled: '0.2.0', running: '0.2.0' });
    expect(misaoVersions(status({ bundledVersion: undefined, daemon: { reachable: false } }))).toEqual({});
  });

  it('maps every unmanaged reason to its own text key', () => {
    expect(unmanagedReasonKey('source_install')).toBe('sourceInstall');
    expect(unmanagedReasonKey('no_bundled_misao')).toBe('noBundledMisao');
    expect(unmanagedReasonKey('unsupported_platform')).toBe('unsupportedPlatform');
    expect(unmanagedReasonKey('invalid_prefix')).toBe('invalidPrefix');
    expect(unmanagedReasonKey(undefined)).toBe('unknown');
  });
});
