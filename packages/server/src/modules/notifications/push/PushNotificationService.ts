import webpush from 'web-push';
import type { PushSubscriptionRecord } from '../SqlitePushSubscriptionRepository';

/** Minimal store surface needed to prune a subscription that the push service rejected. */
export interface SubscriptionPruner {
  deleteByEndpoint(endpoint: string): void;
}

/**
 * HTTP status codes for which the subscription itself is gone and should be pruned
 * so dead rows do not accumulate and waste every future send: 404 Not Found /
 * 410 Gone (RFC 8030 — the subscription no longer exists at the push service).
 *
 * We deliberately do NOT prune on 400/403 VAPID errors (e.g. Apple's
 * `VapidPkHashMismatch` / `BadJwtToken`): those signal a mismatch between the
 * request's VAPID key/subject and the subscription, which can equally be caused
 * by a *server-side* misconfiguration (wrong keys). Pruning on them would let a
 * transient server misconfig wipe every otherwise-valid subscription. A truly
 * key-mismatched subscription is harmless to keep — it just logs one failed send
 * until the client re-subscribes (which produces a fresh endpoint anyway).
 */
const PRUNE_STATUS_CODES = new Set([404, 410]);

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export class PushNotificationService {
  constructor(
    private vapidKeys: { publicKey: string; privateKey: string },
    private email: string,
    private subscriptionStore?: SubscriptionPruner,
  ) {
    webpush.setVapidDetails(`mailto:${email}`, vapidKeys.publicKey, vapidKeys.privateKey);
  }

  async sendToAll(
    subscriptions: PushSubscriptionRecord[],
    payloadOrFn: PushPayload | ((sub: PushSubscriptionRecord) => PushPayload),
  ): Promise<void> {
    const CONCURRENCY = 10;
    for (let i = 0; i < subscriptions.length; i += CONCURRENCY) {
      const chunk = subscriptions.slice(i, i + CONCURRENCY);
      const promises = chunk.map(async (sub) => {
        const payload = typeof payloadOrFn === 'function' ? payloadOrFn(sub) : payloadOrFn;
        const payloadStr = JSON.stringify(payload);
        try {
          const result = await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth },
            },
            payloadStr,
            { timeout: 10_000 },
          );
          console.log(`[Push] Sent to ${sub.endpoint.slice(0, 50)}... status=${result.statusCode}`);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          const body = (err as { body?: string }).body;
          console.error(`[Push] Failed for ${sub.endpoint.slice(0, 50)}... status=${statusCode} body=${body}`);
          if (statusCode !== undefined && PRUNE_STATUS_CODES.has(statusCode)) {
            this.subscriptionStore?.deleteByEndpoint(sub.endpoint);
            console.log(`[Push] Pruned dead subscription (status=${statusCode}): ${sub.endpoint.slice(0, 50)}...`);
          }
        }
      });
      await Promise.allSettled(promises);
    }
  }
}
