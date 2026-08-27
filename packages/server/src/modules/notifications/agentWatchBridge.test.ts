import { describe, it, expect, vi } from 'vitest';
import { notifyAgentWatchesOnIdle } from './agentWatchBridge';
import type { AgentWatchRecord } from './SqliteAgentWatchRepository';
import type { PushSubscriptionRecord } from './SqlitePushSubscriptionRepository';

function makeWatch(overrides: Partial<AgentWatchRecord> = {}): AgentWatchRecord {
  return {
    id: 1,
    endpoint: 'https://push.example/ep1',
    serverName: 'local',
    target: 'session:0',
    label: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSub(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    id: 1,
    endpoint: 'https://push.example/ep1',
    keysP256dh: 'p256dh',
    keysAuth: 'auth',
    createdAt: '2026-01-01T00:00:00.000Z',
    lang: 'en',
    ...overrides,
  };
}

describe('notifyAgentWatchesOnIdle', () => {
  it('sends a push and deletes the watch when the agent goes idle', async () => {
    const watch = makeWatch();
    const sub = makeSub();
    const deleteById = vi.fn();
    const sendToAll = vi.fn().mockResolvedValue(undefined);

    await notifyAgentWatchesOnIdle(
      { serverName: 'local', target: 'session:0', running: false },
      {
        agentWatchRepo: { findByKey: vi.fn().mockReturnValue([watch]), deleteById },
        pushSubRepo: { findByEndpoint: vi.fn().mockReturnValue(sub) },
        pushService: { sendToAll },
      },
    );

    expect(sendToAll).toHaveBeenCalledTimes(1);
    const payloadFn = sendToAll.mock.calls[0][1] as (subscription: PushSubscriptionRecord) => { title: string; data: { url: string } };
    const payload = payloadFn(sub);
    expect(payload.title).toBe('AZITO: Agent Idle');
    expect(payload.data.url).toBe('/?server=local&target=session%3A0');
    expect(payload.data.url).not.toBe('/workspace');
    expect(payload.data.url).not.toBe('/tasks');
    expect(deleteById).toHaveBeenCalledWith(watch.id);
  });

  it('does nothing when the agent is still running', async () => {
    const findByKey = vi.fn();
    const sendToAll = vi.fn();

    await notifyAgentWatchesOnIdle(
      { serverName: 'local', target: 'session:0', running: true },
      {
        agentWatchRepo: { findByKey, deleteById: vi.fn() },
        pushSubRepo: { findByEndpoint: vi.fn() },
        pushService: { sendToAll },
      },
    );

    expect(findByKey).not.toHaveBeenCalled();
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('does nothing when there is no watch for the key', async () => {
    const sendToAll = vi.fn();

    await notifyAgentWatchesOnIdle(
      { serverName: 'local', target: 'session:0', running: false },
      {
        agentWatchRepo: { findByKey: vi.fn().mockReturnValue([]), deleteById: vi.fn() },
        pushSubRepo: { findByEndpoint: vi.fn() },
        pushService: { sendToAll },
      },
    );

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('deletes the watch even if the push send fails', async () => {
    const watch = makeWatch();
    const sub = makeSub();
    const deleteById = vi.fn();
    const sendToAll = vi.fn().mockRejectedValue(new Error('push provider error'));

    await notifyAgentWatchesOnIdle(
      { serverName: 'local', target: 'session:0', running: false },
      {
        agentWatchRepo: { findByKey: vi.fn().mockReturnValue([watch]), deleteById },
        pushSubRepo: { findByEndpoint: vi.fn().mockReturnValue(sub) },
        pushService: { sendToAll },
      },
    );

    expect(deleteById).toHaveBeenCalledWith(watch.id);
  });

  it('deletes the watch without sending when the subscription no longer exists', async () => {
    const watch = makeWatch();
    const deleteById = vi.fn();
    const sendToAll = vi.fn();

    await notifyAgentWatchesOnIdle(
      { serverName: 'local', target: 'session:0', running: false },
      {
        agentWatchRepo: { findByKey: vi.fn().mockReturnValue([watch]), deleteById },
        pushSubRepo: { findByEndpoint: vi.fn().mockReturnValue(null) },
        pushService: { sendToAll },
      },
    );

    expect(sendToAll).not.toHaveBeenCalled();
    expect(deleteById).toHaveBeenCalledWith(watch.id);
  });
});
