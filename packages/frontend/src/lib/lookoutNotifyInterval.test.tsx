import { afterEach, expect, it, vi } from 'vitest';
import { readLookoutNotifyInterval, writeLookoutNotifyInterval } from './lookoutNotifyInterval';
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it('defaults to five minutes on invalid or inaccessible storage', () => {
  localStorage.setItem('azito-lookout-notify-interval', 'invalid');
  expect(readLookoutNotifyInterval()).toBe('5min');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readLookoutNotifyInterval()).toBe('5min');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(() => writeLookoutNotifyInterval('off')).not.toThrow();
});
