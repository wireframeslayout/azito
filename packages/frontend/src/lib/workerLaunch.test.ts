import { describe, it, expect } from 'vitest';
import type { HostFeature } from '@azito/shared';
import { workerLaunchBlock, type AddWindowRequest } from './workerLaunch';
import { hostFeatureBlockReason } from './hostFeature';
import type { TFunction } from 'i18next';

const t = ((key: string) => key) as unknown as TFunction;

/** The block reasons of two servers, as `useHostFeatureBlock` answers them from the server list. */
const PROFILES: Record<string, { platform: 'win32' | 'linux' }> = { winbox: { platform: 'win32' }, linbox: { platform: 'linux' } };
const blockFor = (serverName: string, feature: HostFeature): string | null => hostFeatureBlockReason(PROFILES[serverName], feature, t);

// A request is sent exactly when the shared gate lets it through: the Add Window form's submit and the quick add both call
// `handleAddWindow`, whose first step is `workerLaunchBlock` with the form state.
const sent = (request: AddWindowRequest): boolean => workerLaunchBlock(request, blockFor) === null;

describe('workerLaunchBlock', () => {
  it('the Add Window form: not sent on Windows with an agent or a command, sent on Linux', () => {
    expect(sent({ mode: 'new', serverName: 'winbox', agent: 'claude' })).toBe(false);
    expect(sent({ mode: 'new', serverName: 'winbox', agent: 'codex' })).toBe(false);
    expect(sent({ mode: 'new', serverName: 'winbox', agent: 'custom' })).toBe(false);
    expect(sent({ mode: 'new', serverName: 'linbox', agent: 'claude' })).toBe(true);
    expect(sent({ mode: 'new', serverName: 'linbox', agent: 'custom' })).toBe(true);
  });

  it('the quick add (claude / codex on a server): not sent on Windows, sent on Linux', () => {
    expect(sent({ mode: 'new', serverName: 'winbox', agent: 'claude' })).toBe(false);
    expect(sent({ mode: 'new', serverName: 'linbox', agent: 'codex' })).toBe(true);
  });

  it('a plain shell is sent on Windows too (the terminal quick add, "none")', () => {
    expect(sent({ mode: 'new', serverName: 'winbox', agent: 'none' })).toBe(true);
  });

  it('registering an existing window or session starts nothing, so it is sent on Windows', () => {
    expect(sent({ mode: 'existing', serverName: 'winbox', agent: 'claude' })).toBe(true);
    expect(sent({ mode: 'session', serverName: 'winbox', agent: 'claude' })).toBe(true);
  });

  it('gives the reason, not just a refusal', () => {
    expect(workerLaunchBlock({ mode: 'new', serverName: 'winbox', agent: 'claude' }, blockFor)).toBe('common:hostFeature.windowsPending');
  });

  it('a server the list does not know is not blocked (the hub answers for itself)', () => {
    expect(sent({ mode: 'new', serverName: 'unlisted', agent: 'claude' })).toBe(true);
  });
});
