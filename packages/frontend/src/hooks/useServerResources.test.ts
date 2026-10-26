import { describe, it, expect } from 'vitest';
import { getHealthLevel, getWorstHealth } from './useServerResources';
import type { ResourceUnavailableReason, ServerResourceEntry } from './useServerResources';

type Measurement = NonNullable<ServerResourceEntry['measurement']>;

const measurement = (memAvailablePercent: number, loadPerCore: number | null = 0.5): Measurement => ({
  memAvailablePercent,
  loadPerCore,
  memTotalBytes: 16e9,
  memAvailableBytes: (16e9 * memAvailablePercent) / 100,
  diskUsedPercent: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
});

describe('getHealthLevel', () => {
  it('is unknown, not critical, for a server that could not be measured', () => {
    expect(getHealthLevel(null)).toBe('unknown');
  });

  it('judges the memory by the same bounds as before', () => {
    expect(getHealthLevel(measurement(50))).toBe('healthy');
    expect(getHealthLevel(measurement(40))).toBe('warning');
    expect(getHealthLevel(measurement(15))).toBe('critical');
  });

  it('judges a host with no load (Windows) by its memory alone', () => {
    expect(getHealthLevel(measurement(50, null))).toBe('healthy');
    expect(getHealthLevel(measurement(10, null))).toBe('critical');
  });
});

describe('getWorstHealth', () => {
  it('orders critical > warning > unknown > healthy', () => {
    expect(getWorstHealth(['healthy', 'unknown', 'warning', 'critical'])).toBe('critical');
    expect(getWorstHealth(['healthy', 'unknown', 'warning'])).toBe('warning');
    expect(getWorstHealth(['healthy', 'unknown'])).toBe('unknown');
    expect(getWorstHealth(['healthy', 'healthy'])).toBe('healthy');
  });

  it('does not let an unmeasured server hide a measured problem', () => {
    expect(getWorstHealth(['unknown', 'critical'])).toBe('critical');
    expect(getWorstHealth(['unknown', 'warning'])).toBe('warning');
  });

  it('is healthy with no servers', () => {
    expect(getWorstHealth([])).toBe('healthy');
  });
});

describe('unavailable reasons in the locales', () => {
  it('every reason the hub can give has a sentence in ja and en', async () => {
    const reasons: ResourceUnavailableReason[] = ['unsupported_os', 'agent_outdated', 'unreachable', 'timeout', 'failed'];
    const ja = (await import('../i18n/locales/ja/common.json')).default.statusbar;
    const en = (await import('../i18n/locales/en/common.json')).default.statusbar;
    for (const reason of reasons) {
      expect(ja.unavailableReason[reason]).toBeTruthy();
      expect(en.unavailableReason[reason]).toBeTruthy();
    }
  });
});
