import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushNotificationService } from './PushNotificationService';
import type { PushSubscriptionRecord } from '../SqlitePushSubscriptionRepository';

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

const VAPID = { publicKey: 'pub', privateKey: 'priv' };

let subId = 0;
function makeSub(endpoint: string): PushSubscriptionRecord {
  return { id: ++subId, endpoint, keysP256dh: 'p', keysAuth: 'a', createdAt: '2026-01-01', lang: 'en' };
}

describe('PushNotificationService.sendToAll — dead subscription pruning', () => {
  let pruner: { deleteByEndpoint: ReturnType<typeof vi.fn<(endpoint: string) => void>> };

  beforeEach(() => {
    sendNotification.mockReset();
    pruner = { deleteByEndpoint: vi.fn<(endpoint: string) => void>() };
  });

  it('prunes subscriptions rejected with 404 / 410 (subscription gone)', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z', pruner);
    sendNotification.mockImplementation((sub: { endpoint: string }) => {
      const code = { gone: 410, missing: 404 }[sub.endpoint];
      if (code) return Promise.reject({ statusCode: code, body: 'dead' });
      return Promise.resolve({ statusCode: 201 });
    });

    await service.sendToAll([makeSub('gone'), makeSub('missing'), makeSub('ok')], { title: 't', body: 'b' });

    expect(pruner.deleteByEndpoint).toHaveBeenCalledWith('gone');
    expect(pruner.deleteByEndpoint).toHaveBeenCalledWith('missing');
    expect(pruner.deleteByEndpoint).not.toHaveBeenCalledWith('ok');
    expect(pruner.deleteByEndpoint).toHaveBeenCalledTimes(2);
  });

  it('does NOT prune on VAPID key/auth errors (400/403) — could be a server-side misconfig', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z', pruner);
    sendNotification.mockImplementation((sub: { endpoint: string }) => {
      const code = { hashmismatch: 400, badjwt: 403 }[sub.endpoint];
      return Promise.reject({ statusCode: code, body: 'VapidPkHashMismatch' });
    });

    await service.sendToAll([makeSub('hashmismatch'), makeSub('badjwt')], { title: 't', body: 'b' });

    expect(pruner.deleteByEndpoint).not.toHaveBeenCalled();
  });

  it('does NOT prune on transient failures (e.g. 500 / network error without status)', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z', pruner);
    sendNotification.mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint === 'server-error') return Promise.reject({ statusCode: 500, body: 'oops' });
      return Promise.reject(new Error('network down')); // no statusCode
    });

    await service.sendToAll([makeSub('server-error'), makeSub('no-status')], { title: 't', body: 'b' });

    expect(pruner.deleteByEndpoint).not.toHaveBeenCalled();
  });

  it('does not throw and still delivers others when one subscription fails', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z', pruner);
    sendNotification.mockImplementation((sub: { endpoint: string }) =>
      sub.endpoint === 'bad'
        ? Promise.reject({ statusCode: 410, body: 'gone' })
        : Promise.resolve({ statusCode: 201 }),
    );

    await expect(
      service.sendToAll([makeSub('bad'), makeSub('good')], { title: 't', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(pruner.deleteByEndpoint).toHaveBeenCalledExactlyOnceWith('bad');
  });

  it('works without a pruner injected (optional store)', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z');
    sendNotification.mockRejectedValue({ statusCode: 410, body: 'gone' });
    await expect(service.sendToAll([makeSub('gone')], { title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});

describe('PushNotificationService.sendToAll — callback payload', () => {
  beforeEach(() => {
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201 });
  });

  it('calls payloadFn per subscription with different lang', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z');
    const sub1 = { ...makeSub('ep1'), lang: 'ja' };
    const sub2 = { ...makeSub('ep2'), lang: 'en' };

    const payloads: string[] = [];
    await service.sendToAll([sub1, sub2], (sub) => {
      const p = { title: `t-${sub.lang}`, body: `b-${sub.lang}` };
      payloads.push(sub.lang);
      return p;
    });

    expect(payloads).toEqual(['ja', 'en']);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(sendNotification.mock.calls[0][1] as string);
    expect(firstPayload.title).toBe('t-ja');
    const secondPayload = JSON.parse(sendNotification.mock.calls[1][1] as string);
    expect(secondPayload.title).toBe('t-en');
  });

  it('works with static payload (backward compat)', async () => {
    const service = new PushNotificationService(VAPID, 'x@y.z');
    await service.sendToAll([makeSub('ep')], { title: 'T', body: 'B' });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendNotification.mock.calls[0][1] as string);
    expect(payload).toEqual({ title: 'T', body: 'B' });
  });
});
