import { describe, it, expect } from 'vitest';
import enSettings from '../../i18n/locales/en/settings.json';
import jaSettings from '../../i18n/locales/ja/settings.json';
import type { SystemUpdateStatus } from '../../hooks/useSystemUpdate';
import { STATUS_LABEL_KEYS, updateStatusNotice, updateStatusTone } from './updateStatusView';

function lookup(tree: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, part) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[part];
  }, tree);
}

describe('update status view', () => {
  it.each([['ja', jaSettings], ['en', enSettings]])('%s has every status label and notice text', (_l, tree) => {
    for (const key of [...Object.values(STATUS_LABEL_KEYS), 'system.checkFailedDetail', 'system.noAssetDetail']) {
      expect(typeof lookup(tree, key), key).toBe('string');
    }
  });

  it('keeps no-asset apart from check-failed and from up-to-date', () => {
    expect(STATUS_LABEL_KEYS['no-asset']).not.toBe(STATUS_LABEL_KEYS['check-failed']);
    expect(STATUS_LABEL_KEYS['no-asset']).not.toBe(STATUS_LABEL_KEYS['up-to-date']);
    expect(updateStatusTone('no-asset')).toBe('orange');
    expect(updateStatusTone('check-failed')).toBe('red');
  });

  it('explains a missing asset with the version and the asset name, without the network advice', () => {
    const notice = updateStatusNotice({ status: 'no-asset', latestVersion: 'v0.11.2', missingAsset: 'azito-hub-v0.11.2-win32-x64.zip' });
    expect(notice).toEqual({
      severity: 'warning',
      key: 'system.noAssetDetail',
      values: { version: 'v0.11.2', asset: 'azito-hub-v0.11.2-win32-x64.zip' },
    });
    expect(lookup(enSettings, 'system.noAssetDetail')).not.toMatch(/network/i);
    expect(lookup(jaSettings, 'system.noAssetDetail')).not.toContain('ネットワーク');
  });

  it('keeps the network advice for a failed check', () => {
    expect(updateStatusNotice({ status: 'check-failed', latestVersion: null, missingAsset: null }))
      .toEqual({ severity: 'danger', key: 'system.checkFailedDetail', values: {} });
  });

  it.each<SystemUpdateStatus>(['up-to-date', 'update-available', 'disabled'])('has no notice for %s', (status) => {
    expect(updateStatusNotice({ status, latestVersion: 'v1.0.0', missingAsset: null })).toBeNull();
  });

  it('refuses a no-asset status that lacks its details instead of inventing text', () => {
    expect(() => updateStatusNotice({ status: 'no-asset', latestVersion: null, missingAsset: null })).toThrow();
  });
});
