import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FINISHED_RETENTION, loadFinishedRetention } from './finishedRetentionSettings';

describe('loadFinishedRetention', () => {
  it('validates each value independently', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ maxCount: 51, retentionMs: 1800000 }) });
    expect(loadFinishedRetention()).toEqual({ maxCount: 10, retentionMs: 1800000 });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ maxCount: 0, retentionMs: 123 }) });
    expect(loadFinishedRetention()).toEqual({ maxCount: 0, retentionMs: DEFAULT_FINISHED_RETENTION.retentionMs });
    vi.stubGlobal('localStorage', { getItem: () => '{' });
    expect(loadFinishedRetention()).toEqual(DEFAULT_FINISHED_RETENTION);
    vi.unstubAllGlobals();
  });
});
