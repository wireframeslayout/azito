import { describe, expect, it, vi } from 'vitest';
import type { EventHandler, GapInfo } from '@misao/sdk' with { 'resolution-mode': 'import' };
import { MisaoPaneStateEvents, type MisaoPaneStateSource } from './misaoPaneStateEvents';

type Event = Parameters<EventHandler>[0];
const event = (type: string, paneId: string | undefined, data: unknown): Event => ({ seq: 1, ts: '2026-10-02T00:00:00.000Z', type, paneId, data }) as Event;

const PANE_A = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXA';
const PANE_B = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXB';
const PANE_C = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXC';

const pane = (paneId: string, windowId: string, agentState: string, decidedBy: string) => (
  { paneId, workspace: 'azito', window: { id: windowId }, agentState, decidedBy }
);

function setup(panes: unknown[] = []) {
  let handler: EventHandler | undefined;
  let gapListener: ((gap: GapInfo) => void) | undefined;
  let connectedListener: (() => void) | undefined;
  let disconnectedListener: (() => void) | undefined;
  let recoveredListener: (() => void) | undefined;
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
    onEventsRecovered: (l: () => void) => { recoveredListener = l; return () => {}; },
    onDisconnected: (l: () => void) => { disconnectedListener = l; return () => {}; },
  } as unknown as MisaoPaneStateSource;
  const onState = vi.fn();
  const onSnapshot = vi.fn();
  const onDisconnected = vi.fn();
  const warn = vi.fn();
  const events = new MisaoPaneStateEvents(source, { handleState: onState, handleSnapshot: onSnapshot, handleDisconnected: onDisconnected }, { warn });
  return {
    events, subscribeEvents, unsubscribe, request, onState, onSnapshot, onDisconnected, warn,
    emit: (e: Event) => handler!(e),
    gap: () => gapListener!({ stream: { kind: 'events' }, reason: 'epoch' } as GapInfo),
    connected: () => connectedListener!(),
    disconnected: () => disconnectedListener!(),
    recovered: () => recoveredListener!(),
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

  it('re-reads every pane after the first subscription, with its location', async () => {
    const { events, onSnapshot, onState } = setup([pane(PANE_A, 'w_1', 'idle', 'bytes')]);
    await events.start();
    expect(onSnapshot).toHaveBeenCalledWith([
      { paneId: PANE_A, state: 'idle', decidedBy: 'bytes', location: { workspace: 'azito', windowId: 'w_1', ordinal: 1 } },
    ]);
    expect(onState).not.toHaveBeenCalled();
  });

  it('numbers the panes of each window in pane id order, whatever order the daemon lists them in', async () => {
    const { events, onSnapshot } = setup([
      pane(PANE_C, 'w_1', 'idle', 'bytes'),
      pane(PANE_B, 'w_2', 'idle', 'bytes'),
      pane(PANE_A, 'w_1', 'working', 'title'),
    ]);
    await events.start();
    const ordinals = Object.fromEntries((onSnapshot.mock.calls[0][0] as Array<{ paneId: string; location: { windowId: string; ordinal: number } }>)
      .map((s) => [s.paneId, `${s.location.windowId}#${s.location.ordinal}`]));
    expect(ordinals).toEqual({ [PANE_A]: 'w_1#1', [PANE_C]: 'w_1#2', [PANE_B]: 'w_2#1' });
  });

  it('re-syncs all panes on a gap and on reconnect, with a single pane.list each', async () => {
    const { events, onSnapshot, request, gap, connected } = setup([pane(PANE_A, 'w_1', 'working', 'exit')]);
    await events.start();
    onSnapshot.mockClear();
    request.mockClear();
    gap();
    await flush();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    connected();
    await flush();
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('pane.list', {});
  });

  it('re-syncs the panes when the events subscription is recovered (events in between were missed)', async () => {
    const { events, onSnapshot, request, recovered } = setup([pane(PANE_A, 'w_1', 'working', 'exit')]);
    await events.start();
    onSnapshot.mockClear();
    request.mockClear();
    recovered();
    await flush();
    expect(request).toHaveBeenCalledWith('pane.list', {});
    expect(onSnapshot).toHaveBeenCalledTimes(1);
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

  it('unsubscribes a subscription that completes after stop()', async () => {
    const { events, subscribeEvents, unsubscribe } = setup();
    let complete!: () => void;
    subscribeEvents.mockImplementationOnce(() => new Promise((r) => {
      complete = () => r({ unsubscribe, cursor: { seq: 0, epoch: 'e' } });
    }));
    const starting = events.start();
    events.stop();
    complete();
    await starting;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stop() unsubscribes the event stream', async () => {
    const { events, unsubscribe } = setup();
    await events.start();
    events.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
