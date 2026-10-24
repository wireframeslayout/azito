import { describe, it, expect } from 'vitest';
import { fileTabServersView, isFailureNewerThanSuccess, retryServersFetch, serverListFrom } from './serversFetch';

describe('serverListFrom', () => {
  it('takes an OK array', () => {
    expect(serverListFrom({ status: 200, body: [{ name: 'a' }] })).toEqual([{ name: 'a' }]);
  });

  it('refuses a 5xx whose JSON body would otherwise be stored as the list, with the server\'s reason', () => {
    expect(() => serverListFrom({ status: 500, body: { error: 'db locked' } })).toThrow('HTTP 500: db locked');
    expect(() => serverListFrom({ status: 502, body: {} })).toThrow('HTTP 502');
  });

  it('refuses an OK answer that is not a list', () => {
    expect(() => serverListFrom({ status: 200, body: { servers: [] } })).toThrow('HTTP 200');
  });
});

describe('isFailureNewerThanSuccess', () => {
  it('records only a failure newer than the last success', () => {
    expect(isFailureNewerThanSuccess(3, 2)).toBe(true);
    expect(isFailureNewerThanSuccess(2, 3)).toBe(false);
    expect(isFailureNewerThanSuccess(0, 0)).toBe(false);
  });
});

describe('a restored file tab across a failing first /servers fetch', () => {
  // `settled: false` is a restored tab whose key may still change; the cached list (when there is one) leaves `serversLoaded` false.
  const restored = { settled: false, serverGone: false };

  for (const cache of ['without a cached list', 'with a cached list'] as const) {
    it(`${cache}: loading -> notice on the first failure -> retry -> file once the fetch succeeds`, () => {
      expect(fileTabServersView({ ...restored, serversLoaded: false, serversError: null })).toBe('loading');
      expect(fileTabServersView({ ...restored, serversLoaded: false, serversError: 'HTTP 502' })).toBe('servers-unavailable');
      // The retry succeeded: the list is loaded, the error is cleared, the tab is settled (or its server is found missing).
      expect(fileTabServersView({ settled: true, serverGone: false, serversLoaded: true, serversError: null })).toBe('file');
      expect(fileTabServersView({ settled: false, serverGone: true, serversLoaded: true, serversError: null })).toBe('server-gone');
    });
  }

  it('a failure after a successful load does not bring the notice back', () => {
    expect(fileTabServersView({ ...restored, serversLoaded: true, serversError: 'HTTP 502' })).toBe('loading');
  });
});

describe('retryServersFetch', () => {
  it('is retrying while it runs and back to normal after a success', async () => {
    const seen: boolean[] = [];
    await retryServersFetch(async () => [], (v) => seen.push(v));
    expect(seen).toEqual([true, false]);
  });

  it('is back to normal after a failure too, so the button can be pressed again', async () => {
    const seen: boolean[] = [];
    await expect(retryServersFetch(() => Promise.reject(new Error('HTTP 502')), (v) => seen.push(v))).resolves.toBeUndefined();
    expect(seen).toEqual([true, false]);
  });
});
