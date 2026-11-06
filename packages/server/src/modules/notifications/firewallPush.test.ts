import { describe, expect, it, vi } from 'vitest';
import { notifyFirewallPush } from './firewallPush';
import type { PushSubscriptionRecord } from './SqlitePushSubscriptionRepository';

describe('firewall push notifications', () => {
  it('delivers a localized reason and commands to each subscription', async () => {
    const subs = [{ lang: 'ja' }, { lang: 'en' }] as PushSubscriptionRecord[];
    const sendToAll = vi.fn().mockResolvedValue({});
    await notifyFirewallPush('host', { state: 'blocked', blockedBy: ['Rule'], commands: ['Get-NetFirewallRule'], checkedAt: 1, networkCategory: 'Private' }, { findAll: () => subs }, { sendToAll });
    expect(sendToAll).toHaveBeenCalledOnce();
    const makePayload = sendToAll.mock.calls[0]![1] as (sub: PushSubscriptionRecord) => { body: string };
    expect(makePayload(subs[0]!).body).toContain('受信 Block');
    expect(makePayload(subs[1]!).body).toContain('inbound Block');
    expect(makePayload(subs[0]!).body).toContain('Get-NetFirewallRule');
  });
  it('does not push an inconclusive diagnosis', async () => {
    const sendToAll = vi.fn();
    await notifyFirewallPush('host', { state: 'unknown', blockedBy: [], commands: [], checkedAt: 1, networkCategory: null }, { findAll: () => [] }, { sendToAll });
    expect(sendToAll).not.toHaveBeenCalled();
  });
});
