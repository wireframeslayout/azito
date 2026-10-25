import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { closedSetupRows, describeMisaoItem, getSetupSummary, type InstallStatusResponse } from './serverSections';

const base = { node: { installed: true }, aztHarness: { installed: true } };

describe('getSetupSummary', () => {
  it('counts the misao daemon of a misao server', () => {
    const status: InstallStatusResponse = { ...base, misao: { installed: false, detail: 'daemon_unreachable' } };
    expect(getSetupSummary(status)).toEqual({ text: 'servers:setup.missingCount', textParams: { count: 1 }, tone: 'orange' });
  });

  it('reports all installed when the misao daemon is up', () => {
    const status: InstallStatusResponse = { ...base, misao: { installed: true, version: '0.2.0' } };
    expect(getSetupSummary(status)).toEqual({ text: 'servers:setup.allInstalled', tone: 'green' });
  });

  it('still counts tmux for a tmux server', () => {
    const status: InstallStatusResponse = { ...base, tmux: { installed: false } };
    expect(getSetupSummary(status).textParams).toEqual({ count: 1 });
  });

  it('does not count a missing optional tmux (a misao server) as a setup gap', () => {
    const status: InstallStatusResponse = { ...base, misao: { installed: true }, tmux: { installed: false, optional: true } };
    expect(getSetupSummary(status)).toEqual({ text: 'servers:setup.allInstalled', tone: 'green' });
  });

  it('reports offline when install-status failed because the agent is unreachable', () => {
    expect(getSetupSummary(null, 'offline')).toEqual({ text: 'servers:setup.offline', tone: 'orange' });
    expect(getSetupSummary(null, 'failed')).toEqual({ text: 'servers:setup.checkFailed', tone: 'red' });
    expect(getSetupSummary(null, null).text).toBe('servers:status.checking');
  });
});

describe('getSetupSummary on a Windows host', () => {
  const win32 = { platform: 'win32' as const };

  it('does not count the rows a Windows host cannot use (tmux, the browser runtime)', () => {
    const status: InstallStatusResponse = {
      node: { installed: true },
      misao: { installed: true },
      tmux: { installed: false },
      aztHarness: { installed: true },
      chromium: { installed: false },
    };
    expect(getSetupSummary(status, null, win32)).toEqual({ text: 'servers:setup.allInstalled', tone: 'green' });
  });

  it('still counts what Windows does use', () => {
    const status: InstallStatusResponse = { node: { installed: false }, misao: { installed: true }, aztHarness: { installed: false } };
    expect(getSetupSummary(status, null, win32).textParams).toEqual({ count: 2 });
  });

  it('counts the same rows on Linux / macOS and on an unrecorded host', () => {
    const status: InstallStatusResponse = { node: { installed: true }, misao: { installed: true }, aztHarness: { installed: false }, chromium: { installed: false } };
    expect(getSetupSummary(status, null, { platform: 'linux' }).textParams).toEqual({ count: 2 });
    expect(getSetupSummary(status, null, null).textParams).toEqual({ count: 2 });
  });
});

describe('closedSetupRows', () => {
  it('closes tmux, the harness and the browser runtime on Windows only', () => {
    expect([...closedSetupRows({ platform: 'win32' })].sort()).toEqual(['chromium', 'tmux']);
    expect(closedSetupRows({ platform: 'darwin' }).size).toBe(0);
    expect(closedSetupRows(undefined).size).toBe(0);
  });
});

describe('describeMisaoItem', () => {
  const t = ((key: string, params?: { version?: string }) => (params?.version ? `${key}:${params.version}` : key)) as unknown as TFunction;

  it('labels the protocol version', () => {
    expect(describeMisaoItem({ installed: true, version: '0.2.0' }, t)).toEqual({ installed: true, version: 'setup.misaoProtocol:0.2.0', detail: undefined });
  });

  it('puts the daemon release before its protocol version', () => {
    expect(describeMisaoItem({ installed: true, version: '0.3.0', daemonVersion: '0.2.0' }, t).version).toBe('0.2.0 · setup.misaoProtocol:0.3.0');
  });

  it.each([
    ['daemon_unreachable', 'overview.misaoUnreachable'],
    ['protocol_incompatible', 'overview.misaoIncompatible'],
    ['driver_not_registered', 'overview.misaoDriverNotRegistered'],
    ['not_installed', 'overview.misaoNotInstalled'],
  ])('translates the %s detail', (detail, key) => {
    expect(describeMisaoItem({ installed: false, detail }, t).detail).toBe(key);
  });

  it('keeps a detail it has no translation for', () => {
    expect(describeMisaoItem({ installed: false, detail: 'socket closed' }, t).detail).toBe('socket closed');
  });
});
