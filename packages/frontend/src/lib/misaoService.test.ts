import { describe, expect, it } from 'vitest';
import type { MisaoServiceStatus } from '@azito/shared';
import { misaoActionsBlocked, misaoInstallConsents, misaoNotices, misaoOtherTaskRunning, misaoServiceChipState, misaoServiceMode, misaoVersions, unmanagedReasonKey } from './misaoService';

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

  it('puts a service loaded into both launchd domains first, even before an incompatible protocol, and blocks the actions', () => {
    const duplicate = status({ serviceDuplicateLoad: true, updateAvailable: true, daemon: { reachable: true, detail: 'protocol_incompatible' } });
    expect(misaoNotices(duplicate)).toEqual(['duplicateLoad', 'incompatible']);
    expect(misaoActionsBlocked(duplicate)).toBe(true);
    expect(misaoActionsBlocked(status())).toBe(false);
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

describe('misaoServiceChipState', () => {
  it('shows a service the manager calls active but whose daemon does not answer as a warning, not running', () => {
    expect(misaoServiceChipState(status({ daemon: { reachable: false, detail: 'daemon_unreachable' } }))).toBe('activeUnreachable');
    expect(misaoServiceChipState(status())).toBe('active');
    expect(misaoServiceChipState(status({ serviceState: 'failed', daemon: { reachable: false } }))).toBe('failed');
    expect(misaoServiceChipState(status({ serviceInstalled: false, serviceState: undefined }))).toBeUndefined();
  });
});

describe('Windows task ownership', () => {
  it('distinguishes another installation and an unknown owner', () => {
    expect(misaoServiceMode(status({ windowsTaskOwner: 'other', serviceInstalled: false }))).toBe('other_task');
    expect(misaoServiceMode(status({ windowsTaskOwner: 'unknown', serviceInstalled: false }))).toBe('unknown_task');
  });
});

describe('misaoInstallConsents', () => {
  const otherTask = { windowsTaskOwner: 'other' as const, serviceInstalled: false, serviceState: undefined };

  it('asks nothing for a plain install', () => {
    expect(misaoInstallConsents(status({ serviceInstalled: false, serviceState: undefined }))).toEqual([]);
  });

  it('asks for the takeover and, when MISAO_SOCKET points elsewhere, for the socket change too', () => {
    expect(misaoInstallConsents(status(otherTask))).toEqual(['takeoverTask']);
    expect(misaoInstallConsents(status({ ...otherTask, socketSetting: 'custom' }))).toEqual(['takeoverTask', 'replaceSocket']);
  });

  it('asks only for the socket change when the task is not another installation\'s', () => {
    expect(misaoInstallConsents(status({ serviceInstalled: false, serviceState: undefined, socketSetting: 'custom' }))).toEqual(['replaceSocket']);
  });

  it('shows the custom socket notice beside a task of another installation', () => {
    expect(misaoNotices(status({ ...otherTask, socketSetting: 'custom' }))).toEqual(['customSocket']);
    expect(misaoNotices(status({ ...otherTask, updateAvailable: true }))).toEqual([]);
  });
});

describe('misaoOtherTaskRunning', () => {
  it('blocks takeover only while the other task is running', () => {
    expect(misaoOtherTaskRunning(status({ windowsTaskOwner: 'other', windowsTaskRunning: true }))).toBe(true);
    expect(misaoOtherTaskRunning(status({ windowsTaskOwner: 'other', windowsTaskRunning: false }))).toBe(false);
    expect(misaoOtherTaskRunning(status({ windowsTaskOwner: 'hub', windowsTaskRunning: true }))).toBe(false);
  });
});
