import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandler, GapInfo } from '@misao/sdk' with { 'resolution-mode': 'import' };
import { CHANGE_COALESCE_MS, MisaoChangeEvents } from './misaoChangeEvents';
import type { MisaoEventSource } from './MisaoConnection';

type Event = Parameters<EventHandler>[0];
const event = (type: string): Event => ({ seq: 1, ts: '2026-10-02T00:00:00.000Z', type, data: {} }) as Event;

function setup() {
  let handler: EventHandler | undefined;
  let gapListener: ((gap: GapInfo) => void) | undefined;
  let connectedListener: (() => void) | undefined;
  let recoveredListener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribeEvents = vi.fn(async (h: EventHandler) => {
    handler = h;
    return { unsubscribe, cursor: { seq: 0, epoch: 'e' } };
  });
  const source: MisaoEventSource = {
    subscribeEvents,
    onGap: (l) => { gapListener = l; return () => {}; },
    onConnected: (l) => { connectedListener = l; return () => {}; },
    onEventsRecovered: (l) => { recoveredListener = l; return () => {}; },
  };
  const onChange = vi.fn();
  const warn = vi.fn();
  const events = new MisaoChangeEvents(source, onChange, { warn });
  return { events, subscribeEvents, unsubscribe, onChange, warn, emit: (type: string) => handler!(event(type)), gap: () => gapListener!({ stream: { kind: 'events' }, reason: 'epoch' }), connected: () => connectedListener!(), recovered: () => recoveredListener!() };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('MisaoChangeEvents', () => {
  it.each(['workspace.created', 'workspace.closed', 'workspace.renamed', 'window.created', 'window.closed', 'window.renamed', 'pane.opened', 'pane.closed', 'pane.exited', 'pane.title', 'pane.label'])('notifies on %s', async (type) => {
    const { events, emit, onChange } = setup();
    await events.install('local');
    emit(type);
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS);
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it.each(['pane.state', 'pane.resized', 'input', 'client.attached', 'daemon.started', 'focus', 'something.new'])('ignores %s', async (type) => {
    const { events, emit, onChange } = setup();
    await events.install('local');
    emit(type);
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS * 5);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('coalesces a burst into one notification per installed server', async () => {
    const { events, emit, onChange, subscribeEvents } = setup();
    await events.install('a');
    await events.install('b');
    expect(subscribeEvents).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) emit('pane.title');
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS);
    expect(onChange.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    emit('window.created');
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('treats a gap as a change', async () => {
    const { events, gap, onChange } = setup();
    await events.install('local');
    gap();
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS);
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it('treats a recovered events subscription as a change', async () => {
    const { events, recovered, onChange } = setup();
    await events.install('local');
    recovered();
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS);
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it('unsubscribes when the last server is uninstalled and drops pending notifications', async () => {
    const { events, emit, unsubscribe, onChange } = setup();
    await events.install('a');
    await events.install('b');
    events.uninstall('a');
    expect(unsubscribe).not.toHaveBeenCalled();
    emit('pane.opened');
    events.uninstall('b');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('subscribes again after a full uninstall and install', async () => {
    const { events, subscribeEvents } = setup();
    await events.install('a');
    events.uninstall('a');
    await events.install('a');
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
  });

  it('install rejects while the daemon is down and the subscription follows the connection', async () => {
    const { events, subscribeEvents, connected, emit, onChange } = setup();
    subscribeEvents.mockRejectedValueOnce(new Error('daemon_unreachable'));
    await expect(events.install('local')).rejects.toThrow('daemon_unreachable');
    connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
    emit('pane.opened');
    await vi.advanceTimersByTimeAsync(CHANGE_COALESCE_MS);
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it('does not subscribe again on reconnect while a subscription is active, and without installed servers does nothing', async () => {
    const { events, subscribeEvents, connected } = setup();
    connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeEvents).not.toHaveBeenCalled();
    await events.install('local');
    connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeEvents).toHaveBeenCalledTimes(1);
  });

  it('reports a failed subscription made on connect', async () => {
    const { events, subscribeEvents, connected, warn } = setup();
    subscribeEvents.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('nope'));
    await expect(events.install('local')).rejects.toThrow('down');
    connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });
});
