import { describe, expect, it } from 'vitest';
import { getSetupSummary, type InstallStatusResponse } from './serverSections';

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
});
