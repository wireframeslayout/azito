import { describe, expect, it, vi } from 'vitest';
import type { EventHandler, GapInfo } from '@misao/sdk' with { 'resolution-mode': 'import' };
import { MisaoPaneStateEvents, type MisaoPaneStateSource } from './misaoPaneStateEvents';

type Event = Parameters<EventHandler>[0];
const event = (type: string, paneId: string | undefined, data: unknown): Event => ({ seq: 1, ts: '2026-10-02T00:00:00.000Z', type, paneId, data }) as Event;

const PANE_A = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXA';

function setup(panes: unknown[] = []) {
  let handler: EventHandler | undefined;
  let gapListener: ((gap: GapInfo) => void) | undefined;
  let connectedListener: (() => void) | undefined;
  let disconnectedListener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribeEvents = vi.fn(async (h: EventHandler) => {
    handler = h;
    return { unsubscribe, cursor: { seq: 0, epoch: 'e' } };
  });
  const request = vi.fn(async () => panes);
  const source = {
    subscribeEvents,
    request,
    onGap: (l: (gap: GapInfo) => void) => { gapListener = l; return () => {}; },
    onConnected: (l: () => void) => { connectedListener = l; return () => {}; },
    onDisconnected: (l: () => void) => { disconnectedListener = l; return () => {}; },
  } as unknown as MisaoPaneStateSource;
  const onState = vi.fn();
  const onDisconnected = vi.fn();
  const warn = vi.fn();
  const events = new MisaoPaneStateEvents(source, onState, onDisconnected, { warn });
  return {
    events, subscribeEvents, unsubscribe, request, onState, onDisconnected, warn,
    emit: (e: Event) => handler!(e),
    gap: () => gapListener!({ stream: { kind: 'events' }, reason: 'epoch' } as GapInfo),
    connected: () => connectedListener!(),
    disconnected: () => disconnectedListener!(),
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('MisaoPaneStateEvents', () => {
  it('reports pane.state events with paneId from the event and state/decidedBy from data', async () => {
    const { events, emit, onState } = setup();
    await events.start();
    emit(event('pane.state', PANE_A, { state: 'working', decidedBy: 'title', prev: 'idle' }));
    expect(onState).toHaveBeenCalledWith({ paneId: PANE_A, state: 'working', decidedBy: 'title' });
  });

  it('ignores other event types and malformed pane.state events', async () => {
    const { events, emit, onState } = setup();
    await events.start();
    emit(event('pane.title', PANE_A, { title: 'x' }));
    emit(event('pane.state', undefined, { state: 'idle', decidedBy: 'bytes' }));
    emit(event('pane.state', PANE_A, { state: 'idle' }));
    emit(event('pane.state', PANE_A, null));
    expect(onState).not.toHaveBeenCalled();
  });

  it('re-reads every pane after the first subscription', async () => {
    const { events, onState } = setup([{ paneId: PANE_A, agentState: 'idle', decidedBy: 'bytes' }]);
    await events.start();
    expect(onState).toHaveBeenCalledWith({ paneId: PANE_A, state: 'idle', decidedBy: 'bytes' });
  });

  it('re-syncs all panes on a gap and on reconnect', async () => {
    const { events, onState, request, gap, connected } = setup([{ paneId: PANE_A, agentState: 'working', decidedBy: 'exit' }]);
    await events.start();
    onState.mockClear();
    gap();
    await flush();
    expect(onState).toHaveBeenCalledTimes(1);
    connected();
    await flush();
    expect(onState).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('pane.list', {});
  });

  it('forwards a disconnect', async () => {
    const { events, onDisconnected, disconnected } = setup();
    await events.start();
    disconnected();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('logs a failed re-sync instead of throwing', async () => {
    const { events, request, gap, warn } = setup();
    await events.start();
    request.mockRejectedValueOnce(new Error('boom'));
    gap();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('stop() unsubscribes the event stream', async () => {
    const { events, unsubscribe } = setup();
    await events.start();
    events.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
