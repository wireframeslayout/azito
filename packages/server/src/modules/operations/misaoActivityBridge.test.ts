import { describe, expect, it, vi } from 'vitest';
import type { MuxRef, PaneOrdinal } from '@azito/shared';
import { MisaoActivityBridge, UNRESOLVED_PANE_TTL_MS, mapMisaoAgentState } from './misaoActivityBridge';
import type { ResolvedWindow } from './PaneHandleResolver';

const PANE = 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXA';
const REF = { kind: 'misao' as const, workspace: 'azito', window: 'w_01J8ZK3M5N7P9Q2R4S6T8V0WXY' };

function resolved(ordinal: number, tmuxTarget = 'win-target'): ResolvedWindow {
  return { windowId: 1, ref: REF, ordinal: ordinal as PaneOrdinal, tmuxTarget };
}

function setup(servers = ['misao1']) {
  const resolve = vi.fn<(serverName: string, handle: string) => Promise<ResolvedWindow | null>>(async () => resolved(1));
  const findWindowByRef = vi.fn<(serverName: string, ref: MuxRef) => { tmuxTarget: string } | undefined>(() => undefined);
  const recordMuxSignal = vi.fn();
  const warn = vi.fn();
  let now = 1_000;
  const bridge = new MisaoActivityBridge({
    resolver: { resolveWindowByPaneHandle: resolve },
    findWindowByRef,
    monitor: { recordMuxSignal },
    listServerNames: () => servers,
    log: { warn },
    now: () => now,
  });
  return { bridge, resolve, findWindowByRef, recordMuxSignal, warn, advance: (ms: number) => { now += ms; } };
}

const located = (state: string, ordinal = 1) => (
  { paneId: PANE, state, decidedBy: 'bytes', location: { workspace: REF.workspace, windowId: REF.window, ordinal } }
);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('mapMisaoAgentState', () => {
  it.each([
    ['working', 'working'], ['blocked', 'blocked'], ['idle', 'idle'], ['exited', 'done'], ['unknown', 'unknown'], ['something-new', 'unknown'],
  ])('%s -> %s', (daemon, expected) => {
    expect(mapMisaoAgentState(daemon)).toBe(expected);
  });
});

describe('MisaoActivityBridge', () => {
  it('records the first pane of a resolved window with the daemon rule name', async () => {
    const { bridge, recordMuxSignal, resolve } = setup();
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    expect(resolve).toHaveBeenCalledWith('misao1', PANE);
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'working', { decidedBy: 'title' });
  });

  it('records only the newest state when an older resolution finishes last', async () => {
    const { bridge, resolve, recordMuxSignal } = setup();
    const pending: Array<() => void> = [];
    resolve.mockImplementation(() => new Promise((r) => { pending.push(() => r(resolved(1))); }));
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'bytes' });
    bridge.handleState({ paneId: PANE, state: 'idle', decidedBy: 'bytes' });
    pending[1]();
    await flush();
    pending[0]();
    await flush();
    expect(recordMuxSignal).toHaveBeenCalledTimes(1);
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'idle', { decidedBy: 'bytes' });
  });

  it('ignores panes other than the first one of a window', async () => {
    const { bridge, resolve, recordMuxSignal } = setup();
    resolve.mockResolvedValue(resolved(2));
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'bytes' });
    await flush();
    expect(recordMuxSignal).not.toHaveBeenCalled();
  });

  it('maps exited to done', async () => {
    const { bridge, recordMuxSignal } = setup();
    bridge.handleState({ paneId: PANE, state: 'exited', decidedBy: 'exit' });
    await flush();
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'done', { decidedBy: 'exit' });
  });

  it('tries the next server when the first does not know the pane', async () => {
    const { bridge, resolve, recordMuxSignal } = setup(['a', 'b']);
    resolve.mockImplementation(async (serverName) => (serverName === 'b' ? resolved(1, 'on-b') : null));
    bridge.handleState({ paneId: PANE, state: 'idle', decidedBy: 'bytes' });
    await flush();
    expect(recordMuxSignal).toHaveBeenCalledWith('b', 'on-b', 'idle', { decidedBy: 'bytes' });
  });

  it('applies the latest state of a pane that is registered after the daemon reported it', async () => {
    const { bridge, resolve, recordMuxSignal } = setup();
    resolve.mockResolvedValue(null);
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    bridge.handleState({ paneId: PANE, state: 'idle', decidedBy: 'bytes' });
    await flush();
    expect(recordMuxSignal).not.toHaveBeenCalled();

    resolve.mockResolvedValue(resolved(1));
    bridge.handleWindowsChanged();
    await flush();
    expect(recordMuxSignal).toHaveBeenCalledTimes(1);
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'idle', { decidedBy: 'bytes' });
  });

  it('stops retrying a pane that stays unresolved past the TTL', async () => {
    const { bridge, resolve, advance } = setup();
    resolve.mockResolvedValue(null);
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    resolve.mockClear();

    advance(UNRESOLVED_PANE_TTL_MS + 1);
    bridge.handleWindowsChanged();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('forgets an unresolved pane once it has exited', async () => {
    const { bridge, resolve } = setup();
    resolve.mockResolvedValue(null);
    bridge.handleState({ paneId: PANE, state: 'exited', decidedBy: 'exit' });
    await flush();
    resolve.mockClear();
    bridge.handleWindowsChanged();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('turns every recorded window unknown on disconnect, and only once', async () => {
    const { bridge, recordMuxSignal } = setup();
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    recordMuxSignal.mockClear();

    bridge.handleDisconnected();
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'unknown');
    bridge.handleDisconnected();
    expect(recordMuxSignal).toHaveBeenCalledTimes(1);
  });

  it('does not touch a window whose pane has exited when the daemon disconnects', async () => {
    const { bridge, recordMuxSignal } = setup();
    bridge.handleState({ paneId: PANE, state: 'exited', decidedBy: 'exit' });
    await flush();
    recordMuxSignal.mockClear();
    bridge.handleDisconnected();
    expect(recordMuxSignal).not.toHaveBeenCalled();
  });

  it('logs a failed resolution instead of throwing', async () => {
    const { bridge, resolve, warn } = setup();
    resolve.mockRejectedValue(new Error('daemon_unreachable'));
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('daemon_unreachable'));
  });
  it('attributes a re-synced pane from its location without asking the daemon', async () => {
    const { bridge, resolve, findWindowByRef, recordMuxSignal } = setup();
    findWindowByRef.mockReturnValue({ tmuxTarget: 'win-target' });
    bridge.handleSnapshot([located('working')]);
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(findWindowByRef).toHaveBeenCalledWith('misao1', REF);
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'working', { decidedBy: 'bytes' });
  });

  it('ignores a re-synced pane that is not the first of its window', async () => {
    const { bridge, findWindowByRef, recordMuxSignal } = setup();
    findWindowByRef.mockReturnValue({ tmuxTarget: 'win-target' });
    bridge.handleSnapshot([located('idle', 2)]);
    await flush();
    expect(recordMuxSignal).not.toHaveBeenCalled();
  });

  it('releases a recorded window whose pane is missing from a re-sync', async () => {
    const { bridge, recordMuxSignal } = setup();
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    recordMuxSignal.mockClear();

    bridge.handleSnapshot([]);
    await flush();
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'unknown');
    bridge.handleDisconnected();
    expect(recordMuxSignal).toHaveBeenCalledTimes(1);
  });

  it('forgets a recorded pane whose window row is gone', async () => {
    const { bridge, resolve, recordMuxSignal } = setup();
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    resolve.mockResolvedValue(null);
    bridge.handleState({ paneId: PANE, state: 'idle', decidedBy: 'bytes' });
    await flush();
    recordMuxSignal.mockClear();

    bridge.handleDisconnected();
    expect(recordMuxSignal).not.toHaveBeenCalled();
  });

  it('forgets the state of a failed resolution, so it is not retried on window changes', async () => {
    const { bridge, resolve } = setup();
    resolve.mockResolvedValueOnce(null);
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    await flush();
    resolve.mockRejectedValueOnce(new Error('daemon_unreachable'));
    bridge.handleWindowsChanged();
    await flush();
    resolve.mockClear();

    bridge.handleWindowsChanged();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps a newer state when an older resolution fails', async () => {
    const { bridge, resolve, recordMuxSignal } = setup();
    let fail!: () => void;
    let succeed!: () => void;
    resolve
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = () => reject(new Error('boom')); }))
      .mockImplementationOnce(() => new Promise((r) => { succeed = () => r(resolved(1)); }));
    bridge.handleState({ paneId: PANE, state: 'working', decidedBy: 'title' });
    bridge.handleState({ paneId: PANE, state: 'idle', decidedBy: 'bytes' });
    fail();
    await flush();
    succeed();
    await flush();
    expect(recordMuxSignal).toHaveBeenCalledWith('misao1', 'win-target', 'idle', { decidedBy: 'bytes' });
  });
});
