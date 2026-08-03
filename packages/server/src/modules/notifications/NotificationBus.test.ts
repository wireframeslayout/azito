import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationBus } from './NotificationBus';
import type { NotificationEvent } from './NotificationEvent';

describe('NotificationBus', () => {
  let bus: NotificationBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new NotificationBus();
  });

  afterEach(() => {
    bus.destroy();
    vi.useRealTimers();
  });

  it('should emit non-session events immediately', () => {
    const received: NotificationEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: 'task:status', payload: { taskId: 1, status: 'done' } });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'task:status', payload: { taskId: 1, status: 'done' } });
  });

  it('should debounce sessions:updated events per server (500ms)', () => {
    const received: NotificationEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: 'sessions:updated', payload: { serverName: 'local' } });
    bus.emit({ type: 'sessions:updated', payload: { serverName: 'local' } });
    bus.emit({ type: 'sessions:updated', payload: { serverName: 'local' } });

    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(500);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'sessions:updated', payload: { serverName: 'local' } });
  });

  it('should debounce independently per server', () => {
    const received: NotificationEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: 'sessions:updated', payload: { serverName: 'server-a' } });
    bus.emit({ type: 'sessions:updated', payload: { serverName: 'server-b' } });

    vi.advanceTimersByTime(500);

    expect(received).toHaveLength(2);
    const servers = received.map((e) => e.type === 'sessions:updated' ? e.payload.serverName : '');
    expect(servers).toContain('server-a');
    expect(servers).toContain('server-b');
  });

  it('should reset debounce timer on subsequent events', () => {
    const received: NotificationEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: 'sessions:updated', payload: { serverName: 'local' } });
    vi.advanceTimersByTime(300);
    expect(received).toHaveLength(0);

    bus.emit({ type: 'sessions:updated', payload: { serverName: 'local' } });
    vi.advanceTimersByTime(300);
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);
  });

  it('should not deliver events after off()', () => {
    const received: NotificationEvent[] = [];
    const listener = (e: NotificationEvent) => received.push(e);
    bus.on(listener);
    bus.off(listener);

    bus.emit({ type: 'task:status', payload: { taskId: 1, status: 'done' } });
    expect(received).toHaveLength(0);
  });

  it('should clear all timers on destroy()', () => {
    const received: NotificationEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: 'sessions:updated', payload: { serverName: 'local' } });
    bus.destroy();

    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(0);
  });

  it('should emit workspace:refresh immediately', () => {
    const received: NotificationEvent[] = [];
    bus.on((e) => received.push(e));

    bus.emit({ type: 'workspace:refresh', payload: {} });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('workspace:refresh');
  });
});
