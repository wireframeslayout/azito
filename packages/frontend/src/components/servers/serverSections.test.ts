import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { describeMisaoItem, getSetupSummary, type InstallStatusResponse } from './serverSections';

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

  it('reports offline when install-status failed because the agent is unreachable', () => {
    expect(getSetupSummary(null, 'offline')).toEqual({ text: 'servers:setup.offline', tone: 'orange' });
    expect(getSetupSummary(null, null).text).toBe('servers:status.checking');
  });
});

describe('describeMisaoItem', () => {
  const t = ((key: string, params?: { version?: string }) => (params?.version ? `${key}:${params.version}` : key)) as unknown as TFunction;

  it('labels the protocol version', () => {
    expect(describeMisaoItem({ installed: true, version: '0.2.0' }, t)).toEqual({ installed: true, version: 'setup.misaoProtocol:0.2.0', detail: undefined });
  });

  it.each([
    ['daemon_unreachable', 'overview.misaoUnreachable'],
    ['misao_disabled', 'overview.misaoDisabled'],
    ['driver_not_registered', 'overview.misaoDriverNotRegistered'],
  ])('translates the %s detail', (detail, key) => {
    expect(describeMisaoItem({ installed: false, detail }, t).detail).toBe(key);
  });

  it('keeps a detail it has no translation for', () => {
    expect(describeMisaoItem({ installed: false, detail: 'socket closed' }, t).detail).toBe('socket closed');
  });
});
