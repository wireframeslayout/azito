import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentActivityMonitor, parseWindowTarget, findLiveWindow } from './AgentActivityMonitor';
import type { ProcessActivityProbeEntry } from './AgentActivityMonitor';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import type { IWindowRepository, Window } from '../windows/Window';
import type { TmuxClient, TmuxSession, TmuxPane } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { NotificationBus } from '../notifications/NotificationBus';

type RunningMap = Record<number, Array<{ taskId: number; target: string; serverName: string }>>;

function makeWindow(overrides: Partial<Window>): Window {
  return {
    id: 1,
    ownerType: 'project',
    projectId: 1,
    taskId: null,
    serverName: 'local',
    tmuxTarget: 'azito:agent-1.1',
    label: 'agent-1',
    isPrimary: false,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePane(overrides: Partial<TmuxPane>): TmuxPane {
  return { index: 1, command: 'claude', title: '', width: 80, height: 24, active: true, pid: 1, ...overrides };
}

/**
 * Build a listSessions()-shaped fixture: one session, one window, given
 * activity. Defaults to a single foreground pane running `claude` (a
 * non-shell command) so existing tests that only exercise activity-freshness
 * logic are unaffected by the foreground-command condition; pass `panes`
 * explicitly to exercise that condition itself.
 */
function makeSessions(
  sessionName: string,
  windowName: string,
  windowIndex: number,
  activity: number,
  panes: TmuxPane[] = [makePane({})],
): TmuxSession[] {
  return [{
    name: sessionName,
    windowCount: 1,
    attached: false,
    created: 0,
    windows: [{ index: windowIndex, name: windowName, active: true, activity, panes }],
  }];
}

describe('AgentActivityMonitor', () => {
  let getRunning: ReturnType<typeof vi.fn>;
  let findAll: ReturnType<typeof vi.fn>;
  let listSessions: ReturnType<typeof vi.fn>;
  let findByName: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let monitor: AgentActivityMonitor;

  beforeEach(() => {
    getRunning = vi.fn<() => RunningMap>().mockReturnValue({});
    findAll = vi.fn<() => Window[]>().mockReturnValue([]);
    listSessions = vi.fn<() => Promise<TmuxSession[]>>().mockResolvedValue([]);
    findByName = vi.fn().mockReturnValue({ name: 'local', type: 'local' } as ServerConfig);
    emit = vi.fn();

    monitor = new AgentActivityMonitor(
      { getRunning } as unknown as ExecuteTaskUseCase,
      { findAll } as unknown as IWindowRepository,
      { listSessions } as unknown as TmuxClient,
      { findByName } as unknown as IServerRepository,
      { emit } as unknown as NotificationBus,
    );
  });

  it('emits agent:activity once when an operation run appears, not again while unchanged', async () => {
    getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });

    await monitor.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'agent:activity',
      payload: { serverName: 'local', target: 'azito:task-10', running: true, source: 'operation', operation: true, taskId: 10, label: undefined },
    });

    await monitor.tick();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits running:false once when a running entry disappears', async () => {
    getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });
    await monitor.tick();
    emit.mockClear();

    getRunning.mockReturnValue({});
    await monitor.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent:activity',
      payload: expect.objectContaining({ target: 'azito:task-10', running: false }),
    }));

    await monitor.tick();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('skips tmux calls entirely when there are no manual candidates', async () => {
    getRunning.mockReturnValue({});
    findAll.mockReturnValue([makeWindow({ windowType: 'terminal', workerType: null })]);

    await monitor.tick();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('prefers operation source over manual for the same key and skips its tmux call', async () => {
    getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:agent-1.1', serverName: 'local' }] });
    findAll.mockReturnValue([makeWindow({ serverName: 'local', tmuxTarget: 'azito:agent-1.1' })]);

    await monitor.tick();
    expect(listSessions).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({ source: 'operation', target: 'azito:agent-1' }),
    ]);
  });

  it('detects a fresh manual agent window as running via live window activity (name match)', async () => {
    // Debounce (START_CONFIRM_ADVANCES=2 within START_WINDOW_TICKS=4):
    // activity must advance twice within the sliding window before it is
    // confirmed running — see the dedicated debounce tests below for the
    // single-advance (focus redraw) case.
    findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
    const base = Math.floor(Date.now() / 1000) - 5;
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
    await monitor.tick();
    expect(emit).not.toHaveBeenCalled();

    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
    await monitor.tick();
    expect(emit).not.toHaveBeenCalled();

    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2));
    await monitor.tick();
    expect(emit).toHaveBeenCalledWith({
      type: 'agent:activity',
      payload: { serverName: 'local', target: 'azito:agent-1', running: true, source: 'manual', operation: false, taskId: 7, label: 'agent-1', projectId: 1, paneName: 'claude' },
    });
  });

  it('treats a fresh manual agent window with only a shell in the foreground as idle', async () => {
    // Core regression case: focusing a pane and typing (or just the shell
    // prompt) bumps window_activity without an agent actually running there.
    findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
    listSessions.mockResolvedValue(makeSessions(
      'azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 5,
      [makePane({ command: 'bash' })],
    ));

    await monitor.tick();
    expect(emit).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toEqual([]);
  });

  it('detects a running agent in the specific pane named by the target even when other panes are shells', async () => {
    findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.2' })]);
    const base = Math.floor(Date.now() / 1000) - 5;
    const panes = [makePane({ index: 1, command: 'bash' }), makePane({ index: 2, command: 'claude' })];
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base, panes));
    await monitor.tick();
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1, panes));
    await monitor.tick();
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2, panes));
    await monitor.tick();

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
    }));
  });

  it('detects a fresh manual agent window as running via index-form target', async () => {
    findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:2.1' })]);
    const base = Math.floor(Date.now() / 1000) - 5;
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'some-other-name', 2, base));
    await monitor.tick();
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'some-other-name', 2, base + 1));
    await monitor.tick();
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'some-other-name', 2, base + 2));
    await monitor.tick();

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ target: 'azito:2', running: true, source: 'manual' }),
    }));
  });

  it('detects a window whose name itself ends in .digits (raw spec, no pane stripping)', async () => {
    // The stored target's trailing `.1` here is part of the window name
    // ("agent-1.1"), not a pane suffix — the raw spec must be tried too.
    findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
    const base = Math.floor(Date.now() / 1000) - 5;
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1.1', 3, base));
    await monitor.tick();
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1.1', 3, base + 1));
    await monitor.tick();
    listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1.1', 3, base + 2));
    await monitor.tick();

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
    }));
  });

  it('does not match a numeric-spec target against a coincidentally numeric window name', async () => {
    // tmux resolves a fully numeric spec as an index; a live window *named* "2"
    // at index 5 must not make the stale index-form target `azito:2.1` running.
    findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:2.1' })]);
    listSessions.mockResolvedValue(makeSessions('azito', '2', 5, Math.floor(Date.now() / 1000)));

    await monitor.tick();
    expect(emit).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toEqual([]);
  });

  it('treats a stale windows-table row (window no longer exists in live tmux) as idle', async () => {
    // Core regression case: display-message used to silently answer with the
    // session's active window even when this target's window was gone, which
    // made stale rows look "running" forever. listSessions must not find it.
    findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:gone-window.1' })]);
    listSessions.mockResolvedValue(makeSessions('azito', 'some-active-window', 9, Math.floor(Date.now() / 1000)));

    await monitor.tick();
    expect(emit).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toEqual([]);
  });

  it('treats a stale manual agent window (activity older than threshold) as idle', async () => {
    findAll.mockReturnValue([makeWindow({})]);
    listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 1, Math.floor(Date.now() / 1000) - 120));

    await monitor.tick();
    expect(emit).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toEqual([]);
  });

  it('treats a failing server query as idle for its candidates without aborting the tick', async () => {
    findAll.mockReturnValue([
      makeWindow({ id: 1, serverName: 'offline-server', tmuxTarget: 'azito:agent-1.1' }),
      makeWindow({ id: 2, serverName: 'local', tmuxTarget: 'azito:agent-2.1', label: 'agent-2' }),
    ]);
    findByName.mockImplementation((name: string) => ({ name, type: name === 'local' ? 'local' : 'ssh' }) as ServerConfig);
    let activity = Math.floor(Date.now() / 1000);
    listSessions.mockImplementation(async (server: ServerConfig) => {
      if (server.name === 'offline-server') throw new Error('connection refused');
      return makeSessions('azito', 'agent-2', 1, activity);
    });

    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();

    activity += 1;
    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();

    activity += 1;
    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ target: 'azito:agent-2', running: true, source: 'manual' }),
    }));
  });

  it('does not reject when a dependency throws synchronously inside the tick', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getRunning.mockImplementation(() => { throw new Error('boom'); });

    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    // The guard must be released so the next tick still runs.
    getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });
    await monitor.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('snapshot returns only currently running entries', async () => {
    getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });
    await monitor.tick();

    expect(monitor.snapshot()).toEqual([
      expect.objectContaining({ serverName: 'local', target: 'azito:task-10', running: true }),
    ]);
  });

  describe('manual start debounce (focus-redraw false positive)', () => {
    it('never confirms running when activity advances only once, then stops advancing', async () => {
      // Core regression case: focusing a pane triggers exactly one TUI
      // redraw (one window_activity advance), then nothing — must not emit.
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
      await monitor.tick(); // baseline observation, no prior value to compare against

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick(); // single advance (the focus redraw) — 1 of 2 required
      expect(emit).not.toHaveBeenCalled();

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick(); // activity stops advancing — streak breaks, never confirmed
      expect(emit).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('confirms running on a later advance even after an intervening tick with no advance (sliding window, not consecutive-only)', async () => {
      // Regression case: a burst-style agent that only writes output every
      // ~10-15s (e.g. tick1 advance, tick2 no advance, tick3 advance) must
      // still be confirmed — the old "N consecutive ticks" rule required
      // every tick to advance and would reset the streak at tick2, never
      // confirming this agent as running.
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
      await monitor.tick(); // baseline observation, no prior value to compare against

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick(); // tick1: advance — 1 of 2 required
      expect(emit).not.toHaveBeenCalled();

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick(); // tick2: no advance — must not reset the window
      expect(emit).not.toHaveBeenCalled();

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2));
      await monitor.tick(); // tick3: advance again — 2 advances within the window, confirmed here
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      }));
    });

    it('does not confirm running when a lone advance ages out of the window before a second advance arrives', async () => {
      // A single advance followed by enough non-advancing ticks to fall out
      // of START_WINDOW_TICKS must be forgotten: a much later second advance
      // is then just a fresh lone advance (1 of 2), not confirmed.
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
      await monitor.tick(); // baseline

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick(); // lone advance
      expect(emit).not.toHaveBeenCalled();

      // Enough ticks with no further advance for the lone advance to age out
      // of the sliding window (START_WINDOW_TICKS=4).
      for (let i = 0; i < 4; i++) {
        listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
        await monitor.tick();
        expect(emit).not.toHaveBeenCalled();
      }

      // A second advance now — but the first has already expired, so this is
      // effectively a fresh lone advance, still not confirmed.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2));
      await monitor.tick();
      expect(emit).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('confirms running on the second of two consecutive activity advances', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
      await monitor.tick(); // baseline
      expect(emit).not.toHaveBeenCalled();

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick(); // 1st consecutive advance — not yet confirmed
      expect(emit).not.toHaveBeenCalled();

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2));
      await monitor.tick(); // 2nd consecutive advance — confirmed running here
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      }));
    });

    it('keeps running while activity stays fresh even without further advances, then ends once stale', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const nowSec = Math.floor(Date.now() / 1000);

      // Confirm running via two consecutive advances (as above).
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, nowSec - 20));
      await monitor.tick();
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, nowSec - 15));
      await monitor.tick();
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, nowSec - 10));
      await monitor.tick();
      emit.mockClear();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true }),
      ]);

      // Activity does not advance further, but is still within the 30s
      // ACTIVITY_THRESHOLD_SEC window — continuation does not re-debounce.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, nowSec - 10));
      await monitor.tick();
      expect(emit).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true }),
      ]);

      // Now activity is older than the threshold — ends.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, nowSec - 120));
      await monitor.tick();
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: false }),
      }));
      expect(monitor.snapshot()).toEqual([]);
    });

    it('does not confirm manual via a single activity advance right after an operation run ends', async () => {
      // A key running as 'operation' must not ride the manual continuation
      // shortcut once the operation ends: residual pane output (prompt
      // redraw) is a single advance and must be debounced like any new key.
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      getRunning.mockReturnValue({ 5: [{ taskId: 7, target: 'azito:agent-1.1', serverName: 'local' }] });

      await monitor.tick(); // running as operation
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'operation' }),
      }));
      emit.mockClear();

      // Operation ends; the window is still live with fresh activity.
      getRunning.mockReturnValue({});
      const base = Math.floor(Date.now() / 1000) - 5;
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
      await monitor.tick();
      // The operation stop must be emitted — not silently converted to manual.
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: false, source: 'operation' }),
      }));
      emit.mockClear();

      // A single residual advance (prompt redraw) — still not confirmed.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick();
      expect(emit).not.toHaveBeenCalled();

      // Activity stops advancing — the streak breaks; never became manual.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick();
      expect(emit).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toEqual([]);
    });
  });

  describe('pane-state classifier (Tier 2)', () => {
    it('confirms a claude window running via a braille-spinner title on the very first tick, with no debounce', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
      listSessions.mockResolvedValue(makeSessions(
        'azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 5,
        [makePane({ command: 'claude', title: '⠐ タスク要約' })],
      ));

      await monitor.tick();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual', status: 'working' }),
      ]);
    });

    it('treats a claude window with a ✳-prefixed idle title as idle even with fresh activity', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
      listSessions.mockResolvedValue(makeSessions(
        'azito', 'agent-1', 3, Math.floor(Date.now() / 1000),
        [makePane({ command: 'claude', title: '✳ タスク要約' })],
      ));

      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('flags a claude window as blocked via its screen tail once activity has advanced, keeping it a running entry', async () => {
      const capturePane = vi.fn().mockResolvedValue({
        stdout: 'Allow this action?\n  enter to select · esc to cancel',
        stderr: '',
        code: 0,
      });
      monitor = new AgentActivityMonitor(
        { getRunning } as unknown as ExecuteTaskUseCase,
        { findAll } as unknown as IWindowRepository,
        { listSessions, capturePane } as unknown as TmuxClient,
        { findByName } as unknown as IServerRepository,
        { emit } as unknown as NotificationBus,
      );

      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
      const base = Math.floor(Date.now() / 1000) - 5;
      // Title alone is inconclusive ('claude' matches no title rule) — the
      // screen tail is only consulted once activity has advanced since the
      // previous tick.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'claude', title: 'claude' })]));
      await monitor.tick(); // baseline — no prior activity to compare against, capture-pane not yet consulted
      expect(capturePane).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toEqual([]);

      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'claude', title: 'claude' })]));
      await monitor.tick();
      expect(capturePane).toHaveBeenCalledWith(expect.anything(), 'azito:agent-1.1', -30);
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual', status: 'blocked' }),
      ]);
    });

    it('does not consult capture-pane for a generic worker (no classifier rules), and still confirms via the Tier 3 heuristic', async () => {
      const capturePane = vi.fn();
      monitor = new AgentActivityMonitor(
        { getRunning } as unknown as ExecuteTaskUseCase,
        { findAll } as unknown as IWindowRepository,
        { listSessions, capturePane } as unknown as TmuxClient,
        { findByName } as unknown as IServerRepository,
        { emit } as unknown as NotificationBus,
      );

      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
      const base = Math.floor(Date.now() / 1000) - 5;
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'some-generic-tool' })]));
      await monitor.tick();
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'some-generic-tool' })]));
      await monitor.tick();
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2, [makePane({ command: 'some-generic-tool' })]));
      await monitor.tick();

      expect(capturePane).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });
  });

  describe('recordHookSignal (Tier 1 event-driven detection)', () => {
    function baseSignal(overrides: Partial<Parameters<AgentActivityMonitor['recordHookSignal']>[0]> = {}) {
      return {
        serverName: 'local',
        sessionName: 'azito',
        windowIndex: 3,
        windowName: 'agent-1',
        paneIndex: 1,
        event: 'start' as const,
        ...overrides,
      };
    }

    // recordHookSignal() fires its own internal tick() synchronously (the
    // `ticking` guard flag is set before the first await), so a `tick()`
    // called immediately afterward from a test would just hit that guard and
    // return without waiting for the real work. Flush the microtask/macrotask
    // queue instead so the internal tick has actually settled.
    async function flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('flips a matching window to running immediately on a start signal, with zero activity advances and even with stale activity', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      // Stale by Tier 2's own threshold — must not matter once a hook signal exists.
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 120));

      monitor.recordHookSignal(baseSignal({ event: 'start' }));
      await flush();

      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });

    it('keeps a window idle on every tick after a stop signal, even while the foreground pane stays non-shell', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));

      monitor.recordHookSignal(baseSignal({ event: 'start' }));
      await flush();
      expect(monitor.snapshot()).toHaveLength(1);

      monitor.recordHookSignal(baseSignal({ event: 'stop' }));
      await flush();
      expect(monitor.snapshot()).toEqual([]);

      // Foreground pane is still non-shell (e.g. claude still drawing its
      // final frame) and activity is fresh — the heuristic would normally
      // light this up, but the idle hook state must suppress it.
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('drops hook state once the foreground pane becomes a bare shell, allowing the heuristic to resume afterward', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'claude' })]));

      monitor.recordHookSignal(baseSignal({ event: 'start' }));
      await flush();
      expect(monitor.snapshot()).toHaveLength(1);

      // Claude crashed without firing Stop — the pane fell back to a shell.
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'bash' })]));
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);

      // Hook state is cleared; the heuristic can now confirm a fresh run from
      // scratch — it must re-earn START_CONFIRM_ADVANCES (2 advances) just
      // like any brand-new key, i.e. a baseline observation plus two advances.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'claude' })]));
      await monitor.tick(); // baseline observation for the sliding window
      expect(monitor.snapshot()).toEqual([]);
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2, [makePane({ command: 'claude' })]));
      await monitor.tick(); // 1st advance
      expect(monitor.snapshot()).toEqual([]);
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 3, [makePane({ command: 'claude' })]));
      await monitor.tick(); // 2nd advance — confirmed here
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });

    it('releases an idle hook state once the pane becomes a bare shell, so a hookless agent in the same pane is later detected by the heuristic', async () => {
      // The Stop hook leaves the key 'idle'; that suppression must not
      // outlive the hooked process. After claude exits (bare shell), a
      // different agent that fires no Claude Code hooks (e.g. codex)
      // starting in the same pane must be detectable via Tier 2 again.
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'claude' })]));

      monitor.recordHookSignal(baseSignal({ event: 'stop' }));
      await flush();
      expect(monitor.snapshot()).toEqual([]);

      // While claude remains in the foreground, the idle hook state keeps
      // suppressing the heuristic even as activity advances.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'claude' })]));
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);

      // claude exits — bare shell; the idle hook state is dropped here.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'bash' })]));
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);

      // A hookless agent (codex) starts in the same pane: baseline + two
      // activity advances confirm it via the heuristic.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2, [makePane({ command: 'codex' })]));
      await monitor.tick(); // baseline observation for the sliding window
      expect(monitor.snapshot()).toEqual([]);
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 3, [makePane({ command: 'codex' })]));
      await monitor.tick(); // 1st advance
      expect(monitor.snapshot()).toEqual([]);
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 4, [makePane({ command: 'codex' })]));
      await monitor.tick(); // 2nd advance — confirmed by the heuristic
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });

    it('drops hook state when the window disappears', async () => {
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));
      monitor.recordHookSignal(baseSignal({ event: 'start' }));
      await flush();
      expect(monitor.snapshot()).toHaveLength(1);

      findAll.mockReturnValue([]);
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('matches by window name, by window index (no pane suffix), requires a matching pane when the target pins one, ignores other servers, and no-ops when nothing matches', async () => {
      // azito:agent-1.2 → name match, pane-pinned (pane 2).
      // azito:3         → index-form match, no pane suffix (matches any pane).
      // other-server's azito:agent-1.1 must never be affected.
      findAll.mockReturnValue([
        makeWindow({ id: 1, serverName: 'local', tmuxTarget: 'azito:agent-1.2', label: 'name-and-pane' }),
        makeWindow({ id: 2, serverName: 'local', tmuxTarget: 'azito:3', label: 'index-form-no-pane' }),
        makeWindow({ id: 3, serverName: 'other-server', tmuxTarget: 'azito:agent-1.1', label: 'other-server' }),
      ]);

      // Pane mismatch on the pane-pinned target: no match for either local window.
      monitor.recordHookSignal(baseSignal({ windowIndex: 3, windowName: 'agent-1', paneIndex: 9 }));
      await flush();
      expect(monitor.snapshot()).toEqual([]);

      // Correct pane on the pane-pinned target — both local windows should
      // flip (the index-form target has no pane suffix, so it matches
      // regardless of paneIndex); the other-server window must not.
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));
      monitor.recordHookSignal(baseSignal({ windowIndex: 3, windowName: 'agent-1', paneIndex: 2 }));
      await flush();

      const targets = monitor.snapshot().map((e) => e.target).sort();
      expect(targets).toEqual(['azito:3', 'azito:agent-1']);
    });

    it('immediately ticks so a caller need not wait for the next poll interval', async () => {
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));

      monitor.recordHookSignal(baseSignal({ event: 'start' }));
      await flush();

      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      }));
    });
  });

  describe('recordSupervisorSignal (Tier 0 event-driven detection)', () => {
    // recordSupervisorSignal() fires its own internal tick() synchronously
    // (same `ticking` guard timing as recordHookSignal) — flush the task
    // queue so that internal tick has actually settled before asserting.
    async function flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('confirms running immediately on an active signal, bypassing the Tier 2 debounce entirely', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      // No listSessions call needed/mocked — Tier 0 must not consult tmux at all.

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active');
      await flush();

      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'supervised' }),
      ]);
    });

    it('marks a supervised agent in a task-bearing windows row as operation:false when no run is registered', async () => {
      // A `windows` row keeps its task_id after the run finished. Launching an
      // agent by hand in that window must NOT look like an operation run, or
      // the in-app "エージェント終了" notification is suppressed (it defers to
      // task:status, which never fires because no task is running).
      getRunning.mockReturnValue({});
      findAll.mockReturnValue([makeWindow({ taskId: 166, tmuxTarget: 'kessen:win--7mvr' })]);

      monitor.recordSupervisorSignal('local', 'kessen:win--7mvr', 'active');
      await flush();

      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ source: 'supervised', operation: false, taskId: 166 }),
      ]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent:activity',
        payload: expect.objectContaining({ running: true, operation: false, taskId: 166 }),
      }));
    });

    it('keeps operation:true for a supervised key that IS a registered execution run', async () => {
      getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });
      findAll.mockReturnValue([]);

      monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'active', 10);
      await flush();

      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ source: 'supervised', operation: true, taskId: 10 }),
      ]);
    });

    it('confirms idle on an idle signal even while a hook state claims the same key is running', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));

      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 3, windowName: 'agent-1', paneIndex: 1, event: 'start',
      });
      await flush();
      expect(monitor.snapshot()).toHaveLength(1);

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'idle');
      await flush();

      expect(monitor.snapshot()).toEqual([]);
    });

    it('releases the key back to Tier 1/2 detection on an exited signal', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      const base = Math.floor(Date.now() / 1000) - 5;

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active');
      await flush();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'supervised' }),
      ]);

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'exited');
      await flush();
      // Tier 0 state is gone; falls through to the Tier 2 heuristic, which
      // has not yet observed any activity for this key — idle.
      expect(monitor.snapshot()).toEqual([]);

      // The heuristic now works normally again for this key.
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base));
      await monitor.tick();
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 1));
      await monitor.tick();
      listSessions.mockResolvedValueOnce(makeSessions('azito', 'agent-1', 3, base + 2));
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });

    it('keeps supervisor state alive for a key no longer among the candidates (a live supervisor connection is its own ground truth)', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);
      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active', 7, 'agent-1');
      await flush();
      expect(monitor.snapshot()).toHaveLength(1);

      // Window removed — the supervisor connection itself is still live, so
      // the key must keep showing as running (now via the pure-supervised
      // path, since it is no longer a windows-table candidate either).
      findAll.mockReturnValue([]);
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'supervised', taskId: 7, label: 'agent-1' }),
      ]);

      // Only an explicit 'exited' signal removes it.
      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'exited');
      await flush();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('immediately ticks so a caller need not wait for the next poll interval', async () => {
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1' })]);

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active');
      await flush();

      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'supervised' }),
      }));
    });

    it('propagates a title-derived blocked status into the entry and emits again on a working→blocked flip', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active', 7, 'agent-1', 'working');
      await flush();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'supervised', status: 'working' }),
      ]);
      emit.mockClear();

      // The agent hit a permission prompt: still running, but blocked.
      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active', 7, 'agent-1', 'blocked');
      await flush();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, status: 'blocked' }),
      ]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({ target: 'azito:agent-1', running: true, status: 'blocked' }),
      }));
    });

    it('leaves status undefined for a signal without one (old supervisor / byte-heuristic fallback)', async () => {
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);

      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active');
      await flush();

      const entry = monitor.snapshot()[0];
      expect(entry).toEqual(expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'supervised' }));
      expect(entry.status).toBeUndefined();
    });

    describe('operation-covered keys', () => {
      it('overrides a running operation entry with source supervised on an active signal, keeping the operation taskId', async () => {
        getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });

        monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'active');
        await flush();

        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:task-10', running: true, source: 'supervised', taskId: 10 }),
        ]);
      });

      it('shows a supervised-idle operation key as idle even while its run is still registered, and keeps it idle across later ticks', async () => {
        getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });

        monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'active');
        await flush();
        expect(monitor.snapshot()).toHaveLength(1);
        emit.mockClear();

        // e.g. waiting_input between turns: the child stopped producing
        // output, the supervisor reported idle, but the operation run is
        // still registered.
        monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'idle');
        await flush();
        expect(monitor.snapshot()).toEqual([]);
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
          payload: expect.objectContaining({ target: 'azito:task-10', running: false, source: 'supervised' }),
        }));

        // The idle supervisor state must survive subsequent poll ticks (not
        // be pruned and silently revert to the coarse operation-running).
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([]);

        // Once the supervisor reports active again, it flips straight back.
        monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'active');
        await flush();
        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:task-10', running: true, source: 'supervised', taskId: 10 }),
        ]);
      });

      it('keeps plain operation entries untouched when no supervisor state exists for the key', async () => {
        getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });

        await monitor.tick();

        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:task-10', running: true, source: 'operation', taskId: 10 }),
        ]);
      });

      it('falls back to the plain operation entry after an exited signal releases the key', async () => {
        getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:task-10.1', serverName: 'local' }] });

        monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'idle');
        await flush();
        expect(monitor.snapshot()).toEqual([]);

        monitor.recordSupervisorSignal('local', 'azito:task-10.1', 'exited');
        await flush();
        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:task-10', running: true, source: 'operation', taskId: 10 }),
        ]);
      });

      it('does not route a supervised-idle operation key through the manual heuristic even when an agent window row shares the key', async () => {
        getRunning.mockReturnValue({ 5: [{ taskId: 7, target: 'azito:agent-1.1', serverName: 'local' }] });
        findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1' })]);

        monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'idle');
        await flush();
        expect(monitor.snapshot()).toEqual([]);

        // The manual path would need listSessions; an operation-covered key
        // must never reach it, supervised-idle or not.
        expect(listSessions).not.toHaveBeenCalled();
      });
    });

    describe('pure supervised keys (no windows row, no operation run)', () => {
      // e.g. a manually launched `azs claude` pane that a tui-supervisor
      // wraps directly — there is no windows-table row and no operation run
      // for it at all; the supervisor connection alone must still surface it.

      it('shows a pure manual supervised key as running with source supervised and its own taskId/label on an active signal', async () => {
        monitor.recordSupervisorSignal('local', 'azito:manual-1.1', 'active', 42, 'claude');
        await flush();

        expect(listSessions).not.toHaveBeenCalled();
        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({
            serverName: 'local', target: 'azito:manual-1', running: true, source: 'supervised', taskId: 42, label: 'claude',
          }),
        ]);
      });

      it('does not surface a pure manual supervised key as an entry while idle', async () => {
        monitor.recordSupervisorSignal('local', 'azito:manual-1.1', 'idle', 42, 'claude');
        await flush();

        expect(monitor.snapshot()).toEqual([]);
      });

      it('removes a pure manual supervised key on an exited signal (child_exit) and does not resurrect it on later ticks', async () => {
        monitor.recordSupervisorSignal('local', 'azito:manual-1.1', 'active', 42, 'claude');
        await flush();
        expect(monitor.snapshot()).toHaveLength(1);

        monitor.recordSupervisorSignal('local', 'azito:manual-1.1', 'exited');
        await flush();
        expect(monitor.snapshot()).toEqual([]);

        await monitor.tick();
        expect(monitor.snapshot()).toEqual([]);
      });

      it('removes a pure manual supervised key on a disconnected-style exited signal', async () => {
        // recordSupervisorSignal(..., 'exited') is what both child_exit and
        // registry 'disconnected' events funnel into (buildServer.ts) — the
        // monitor itself has one removal path for both.
        monitor.recordSupervisorSignal('local', 'azito:manual-2.1', 'active', null, 'codex');
        await flush();
        expect(monitor.snapshot()).toHaveLength(1);

        monitor.recordSupervisorSignal('local', 'azito:manual-2.1', 'exited');
        await flush();
        expect(monitor.snapshot()).toEqual([]);
      });

      it('does not consult tmux and survives repeated ticks with no candidates at all', async () => {
        findAll.mockReturnValue([]);
        getRunning.mockReturnValue({});

        monitor.recordSupervisorSignal('local', 'azito:manual-1.1', 'active', 42, 'claude');
        await flush();

        await monitor.tick();
        await monitor.tick();

        expect(listSessions).not.toHaveBeenCalled();
        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:manual-1', running: true, source: 'supervised' }),
        ]);
      });
    });
  });

  describe('pane ID target guard', () => {
    it('parseWindowTarget returns empty session/windowSpec for pane ID format (%N)', () => {
      expect(parseWindowTarget('%912')).toEqual({ sessionName: '', windowSpec: '' });
      expect(parseWindowTarget('%0')).toEqual({ sessionName: '', windowSpec: '' });
    });

    it('parseWindowTarget correctly parses session:window.pane format', () => {
      expect(parseWindowTarget('sess:task-42.1')).toEqual({ sessionName: 'sess', windowSpec: 'task-42.1' });
      expect(parseWindowTarget('azito:agent-1')).toEqual({ sessionName: 'azito', windowSpec: 'agent-1' });
    });

    it('findLiveWindow returns null for pane ID format target', () => {
      const sessions = makeSessions('azito', 'task-42', 1, Math.floor(Date.now() / 1000));
      expect(findLiveWindow(sessions, '%912')).toBeNull();
    });

    it('findLiveWindow returns matching window for session:window format target', () => {
      const sessions = makeSessions('azito', 'task-42', 1, Math.floor(Date.now() / 1000));
      const result = findLiveWindow(sessions, 'azito:task-42.1');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('task-42');
    });

    it('does not create a duplicate entry when operation target matches windows table tmuxTarget', async () => {
      const target = 'azito:task-10.1';
      getRunning.mockReturnValue({ 5: [{ taskId: 10, target, serverName: 'local' }] });
      findAll.mockReturnValue([makeWindow({ taskId: 10, tmuxTarget: target })]);

      await monitor.tick();

      const entries = monitor.snapshot();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('operation');
      expect(entries[0].target).toBe('azito:task-10');
    });
  });

  describe('window-level dedup (same tmux window, multiple DB rows)', () => {
    const nowSec = Math.floor(Date.now() / 1000);

    async function flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('deduplicates project-owned and task-owned rows into one entry and prefers taskId', async () => {
      findAll.mockReturnValue([
        makeWindow({ id: 1, ownerType: 'project', taskId: null, tmuxTarget: 'azito:win--2sg1', serverName: 'local' }),
        makeWindow({ id: 2, ownerType: 'task', taskId: 42, tmuxTarget: 'azito:win--2sg1.1', serverName: 'local' }),
      ]);
      listSessions.mockResolvedValue(makeSessions('azito', 'win--2sg1', 5, nowSec));

      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 5,
        windowName: 'win--2sg1', paneIndex: 1, event: 'start',
      });
      await flush();

      const entries = monitor.snapshot();
      expect(entries).toHaveLength(1);
      expect(entries[0].taskId).toBe(42);
    });

    it('does not merge unrelated windows on the same server', async () => {
      findAll.mockReturnValue([
        makeWindow({ id: 1, tmuxTarget: 'azito:win--2sg1', serverName: 'local' }),
        makeWindow({ id: 2, tmuxTarget: 'azito:win--abc', serverName: 'local' }),
      ]);
      listSessions.mockResolvedValue([{
        name: 'azito',
        windowCount: 2,
        attached: false,
        created: 0,
        windows: [
          { index: 1, name: 'win--2sg1', active: true, activity: nowSec, panes: [makePane({})] },
          { index: 2, name: 'win--abc', active: true, activity: nowSec, panes: [makePane({})] },
        ],
      }]);

      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 1,
        windowName: 'win--2sg1', paneIndex: 0, event: 'start',
      });
      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 2,
        windowName: 'win--abc', paneIndex: 0, event: 'start',
      });
      await flush();

      const entries = monitor.snapshot();
      expect(entries).toHaveLength(2);
    });

    it('excludes window-table rows when operation covers the same window (pane suffix differs)', async () => {
      getRunning.mockReturnValue({ 5: [{ taskId: 10, target: 'azito:win--2sg1.0', serverName: 'local' }] });
      findAll.mockReturnValue([
        makeWindow({ id: 1, tmuxTarget: 'azito:win--2sg1', serverName: 'local' }),
      ]);
      listSessions.mockResolvedValue(makeSessions('azito', 'win--2sg1', 5, nowSec));

      await monitor.tick();

      const entries = monitor.snapshot();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('operation');
    });

    it('hook and supervisor signals with different pane suffixes converge to the same entry', async () => {
      findAll.mockReturnValue([
        makeWindow({ id: 1, ownerType: 'project', taskId: null, tmuxTarget: 'azito:win--2sg1', serverName: 'local' }),
        makeWindow({ id: 2, ownerType: 'task', taskId: 42, tmuxTarget: 'azito:win--2sg1.1', serverName: 'local' }),
      ]);
      listSessions.mockResolvedValue(makeSessions('azito', 'win--2sg1', 5, nowSec));

      // Hook signal matches the project-owned row (no pane suffix)
      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 5,
        windowName: 'win--2sg1', paneIndex: 0, event: 'start',
      });
      await flush();

      expect(monitor.snapshot()).toHaveLength(1);

      // Supervisor signal arrives with the pane-suffixed target
      monitor.recordSupervisorSignal('local', 'azito:win--2sg1.1', 'active', 42);
      await flush();

      // Still one entry (supervisor overrides hook for same window key)
      const entries = monitor.snapshot();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('supervised');
      expect(entries[0].taskId).toBe(42);
      expect(entries[0].target).toBe('azito:win--2sg1');
    });

    it('running→finished transition uses the same normalized target so frontend dedup works', async () => {
      findAll.mockReturnValue([
        makeWindow({ id: 1, ownerType: 'task', taskId: 42, tmuxTarget: 'azito:win--2sg1.1', serverName: 'local' }),
      ]);
      listSessions.mockResolvedValue(makeSessions('azito', 'win--2sg1', 5, nowSec));

      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 5,
        windowName: 'win--2sg1', paneIndex: 1, event: 'start',
      });
      await flush();

      const runningTarget = monitor.snapshot()[0]?.target;
      expect(runningTarget).toBe('azito:win--2sg1');

      // Stop signal → entry disappears, emitted target matches
      emit.mockClear();
      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 5,
        windowName: 'win--2sg1', paneIndex: 1, event: 'stop',
      });
      await flush();

      expect(monitor.snapshot()).toEqual([]);
      const finishedPayload = emit.mock.calls.find(
        (c: unknown[]) => (c[0] as { payload: { running: boolean } }).payload.running === false,
      )?.[0] as { payload: { target: string } } | undefined;
      expect(finishedPayload?.payload.target).toBe(runningTarget);
    });
  });

  describe('Tier 4 (process/transcript probe)', () => {
    /** The probe refresh is fire-and-forget; let it settle before the next tick reads its cache. */
    async function settleProbe(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** Probe rows in tests only set what they exercise; the outcome fields default to "nothing observed". */
    type PartialProbeEntry = Omit<ProcessActivityProbeEntry, 'completedAt' | 'interruptedAt'>
      & Partial<Pick<ProcessActivityProbeEntry, 'completedAt' | 'interruptedAt'>>;

    function makeMonitorWithProbe(
      list: () => Promise<PartialProbeEntry[]>,
      capturePane = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
    ): AgentActivityMonitor {
      const probe = {
        list: async (): Promise<ProcessActivityProbeEntry[]> =>
          (await list()).map((e) => ({ completedAt: null, interruptedAt: null, ...e })),
      };
      return new AgentActivityMonitor(
        { getRunning } as unknown as ExecuteTaskUseCase,
        { findAll } as unknown as IWindowRepository,
        { listSessions, capturePane } as unknown as TmuxClient,
        { findByName } as unknown as IServerRepository,
        { emit } as unknown as NotificationBus,
        probe,
      );
    }

    it('promotes a window no higher tier can speak for to running when the probe reports working', async () => {
      const list = vi.fn().mockResolvedValue([{ serverName: 'local', target: 'azito:agent-1', status: 'working' as const }]);
      monitor = makeMonitorWithProbe(list);
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
      // Activity stale enough that the Tier 3 heuristic would call this idle —
      // Tier 4 must decide before it is ever reached.
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600,
        [makePane({ command: 'claude', title: 'claude' })]));

      await monitor.tick(); // kicks the probe refresh (fire-and-forget)
      await settleProbe();

      await monitor.tick();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });

    it('does not let a probe "idle" darken a window the Tier 3 heuristic would confirm', async () => {
      // The probe answers 'idle' both for a genuinely quiet agent and for a
      // window whose session it could not resolve at all, so it must not be
      // able to suppress Tier 3 — Tier 4 is additive only.
      monitor = makeMonitorWithProbe(async () => [{ serverName: 'local', target: 'azito:agent-1', status: 'idle' as const }]);
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
      const base = Math.floor(Date.now() / 1000);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'some-generic-tool' })]));

      await monitor.tick();
      await settleProbe();
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'some-generic-tool' })]));
      await monitor.tick();
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base + 2, [makePane({ command: 'some-generic-tool' })]));
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([
        expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
      ]);
    });

    it('never re-lights a key the supervisor (Tier 0) reported idle', async () => {
      monitor = makeMonitorWithProbe(async () => [{ serverName: 'local', target: 'azito:agent-1', status: 'working' as const }]);
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000),
        [makePane({ command: 'claude', title: 'claude' })]));

      await monitor.tick();
      await settleProbe();
      monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'idle');
      await settleProbe();

      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('never re-lights a key the hook (Tier 1) reported idle', async () => {
      monitor = makeMonitorWithProbe(async () => [{ serverName: 'local', target: 'azito:agent-1', status: 'working' as const }]);
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000),
        [makePane({ command: 'claude', title: 'claude' })]));

      await monitor.tick();
      await settleProbe();
      monitor.recordHookSignal({
        serverName: 'local', sessionName: 'azito', windowIndex: 3,
        windowName: 'agent-1', paneIndex: 1, event: 'stop',
      });
      await settleProbe();

      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
    });

    it('never re-lights a key the pane classifier (Tier 2) resolved as idle', async () => {
      monitor = makeMonitorWithProbe(async () => [{ serverName: 'local', target: 'azito:agent-1', status: 'working' as const }]);
      // A codex window whose title the classifier reads as idle.
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'codex' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000),
        [makePane({ command: 'codex', title: 'codex' })]));

      await monitor.tick();
      await settleProbe();
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
    });


    it('stops trusting the cached snapshot once the probe keeps failing, instead of pinning a stale working', async () => {
      vi.useFakeTimers();
      try {
        const list = vi.fn()
          .mockResolvedValueOnce([{ serverName: 'local', target: 'azito:agent-1', status: 'working' as const }])
          .mockRejectedValue(new Error('ps failed'));
        monitor = makeMonitorWithProbe(list);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
        // Stale tmux activity: without Tier 4 this key is idle.
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));

        await monitor.tick();
        await vi.advanceTimersByTimeAsync(0);
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:agent-1', running: true }),
        ]);

        // Probe now fails on every refresh; the last good snapshot may serve for
        // a while, but must not keep the key lit past PROCESS_PROBE_MAX_AGE_MS.
        await vi.advanceTimersByTimeAsync(61_000);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([]);
        expect(list.mock.calls.length).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let a cached "working" convert an ended operation run into a manual entry', async () => {
      monitor = makeMonitorWithProbe(async () => [{ serverName: 'local', target: 'azito:agent-1', status: 'working' as const }]);
      findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
      getRunning.mockReturnValue({ 5: [{ taskId: 7, target: 'azito:agent-1.1', serverName: 'local' }] });

      await monitor.tick();
      await settleProbe();
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([expect.objectContaining({ source: 'operation', operation: true })]);

      // Run ends: the probe cache still says 'working' for this key, but the
      // operation's running:false transition must still be emitted and the key
      // must not silently reappear as a manual/Tier 4 entry.
      emit.mockClear();
      getRunning.mockReturnValue({});
      await monitor.tick();
      expect(monitor.snapshot()).toEqual([]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'agent:activity',
        payload: expect.objectContaining({ target: 'azito:agent-1', running: false, operation: true }),
      }));
    });

    it('re-arms Tier 4 for an ex-operation key once a fresh probe observes it non-working', async () => {
      vi.useFakeTimers();
      try {
        const status: { value: 'working' | 'idle' } = { value: 'working' };
        monitor = makeMonitorWithProbe(async () => [{ serverName: 'local', target: 'azito:agent-1', status: status.value }]);
        findAll.mockReturnValue([makeWindow({ taskId: 7, tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
        getRunning.mockReturnValue({ 5: [{ taskId: 7, target: 'azito:agent-1.1', serverName: 'local' }] });
        await monitor.tick();
        await vi.advanceTimersByTimeAsync(0);

        getRunning.mockReturnValue({});
        await monitor.tick(); // disarmed — no manual entry despite the cached 'working'
        expect(monitor.snapshot()).toEqual([]);

        // A fresh probe observes it stopped → re-arm.
        status.value = 'idle';
        await vi.advanceTimersByTimeAsync(16_000);
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([]);

        // It starts working again as a hand-driven agent: Tier 4 may speak now.
        status.value = 'working';
        await vi.advanceTimersByTimeAsync(16_000);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([
          expect.objectContaining({ target: 'azito:agent-1', running: true, source: 'manual' }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not await the probe on the tick path and survives a failing probe', async () => {
      const list = vi.fn().mockRejectedValue(new Error('ps failed'));
      monitor = makeMonitorWithProbe(list);
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));

      await expect(monitor.tick()).resolves.toBeUndefined();
      await settleProbe();
      await expect(monitor.tick()).resolves.toBeUndefined();
      expect(monitor.snapshot()).toEqual([]);
    });

    describe('stop reason (P3: finished 意味論の reason 駆動化)', () => {
      /** The `running: false` payload of the most recent emit for `target`, if any. */
      function lastStopPayload(target: string): { running: boolean; reason?: string } | undefined {
        const calls = emit.mock.calls
          .map((c: unknown[]) => (c[0] as { payload: { target: string; running: boolean; reason?: string } }).payload)
          .filter((p) => p.target === target && p.running === false);
        return calls[calls.length - 1];
      }

      it("labels a Tier 2 working→idle stop as 'completed'", async () => {
        monitor = makeMonitorWithProbe(async () => []);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
        const now = Math.floor(Date.now() / 1000);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, now, [makePane({ command: 'claude', title: '⠐ working' })]));
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([expect.objectContaining({ running: true })]);

        emit.mockClear();
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, now, [makePane({ command: 'claude', title: '✳ idle' })]));
        await monitor.tick();
        expect(lastStopPayload('azito:agent-1')?.reason).toBe('completed');
      });

      it("labels a hook Stop signal as 'completed'", async () => {
        monitor = makeMonitorWithProbe(async () => []);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000),
          [makePane({ command: 'claude', title: '⠐ working' })]));
        await monitor.tick();

        emit.mockClear();
        monitor.recordHookSignal({
          serverName: 'local', sessionName: 'azito', windowIndex: 3,
          windowName: 'agent-1', paneIndex: 1, event: 'stop',
        });
        await settleProbe(); // recordHookSignal ticks internally (fire-and-forget)
        await monitor.tick();
        expect(lastStopPayload('azito:agent-1')?.reason).toBe('completed');
      });

      it("labels a supervisor active→idle report as 'completed'", async () => {
        monitor = makeMonitorWithProbe(async () => []);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));
        monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'active');
        await settleProbe(); // recordSupervisorSignal ticks internally
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([expect.objectContaining({ running: true, source: 'supervised' })]);

        emit.mockClear();
        monitor.recordSupervisorSignal('local', 'azito:agent-1.1', 'idle');
        await settleProbe();
        await monitor.tick();
        expect(lastStopPayload('azito:agent-1')?.reason).toBe('completed');
      });

      it("labels a vanished window as 'deleted' and does not repeat the announcement", async () => {
        monitor = makeMonitorWithProbe(async () => []);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000),
          [makePane({ command: 'claude', title: '⠐ working' })]));
        await monitor.tick();

        emit.mockClear();
        findAll.mockReturnValue([]); // window row deleted
        listSessions.mockResolvedValue([]);
        await monitor.tick();
        expect(lastStopPayload('azito:agent-1')?.reason).toBe('deleted');

        emit.mockClear();
        await monitor.tick();
        expect(emit).not.toHaveBeenCalled();
      });

      it("announces 'deleted' once for a window that was already idle, so a finished row can be dropped", async () => {
        monitor = makeMonitorWithProbe(async () => []);
        // Idle from the start (bare shell foreground, stale activity): never running.
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'claude' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([]);

        emit.mockClear();
        findAll.mockReturnValue([]);
        await monitor.tick();
        expect(lastStopPayload('azito:agent-1')).toEqual(expect.objectContaining({ reason: 'deleted' }));

        emit.mockClear();
        await monitor.tick();
        expect(emit).not.toHaveBeenCalled();
      });

      it("labels a probe-observed interrupt as 'interrupted', never as a completion", async () => {
        vi.useFakeTimers();
        try {
          const probe: { status: 'working' | 'idle'; interruptedAt: number | null } = { status: 'working', interruptedAt: null };
          monitor = makeMonitorWithProbe(async () => [{
            serverName: 'local', target: 'azito:agent-1', status: probe.status, interruptedAt: probe.interruptedAt,
          }]);
          findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
          listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
          await monitor.tick();
          await vi.advanceTimersByTimeAsync(0);
          await monitor.tick();
          expect(monitor.snapshot()).toEqual([expect.objectContaining({ running: true })]);

          // The user hits Esc: the transcript's last meaningful entry becomes an
          // interrupt marker. The key stops, but this is not a completion.
          probe.status = 'idle';
          probe.interruptedAt = Date.now();
          await vi.advanceTimersByTimeAsync(16_000);
          emit.mockClear();
          listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));
          await monitor.tick();
          expect(monitor.snapshot()).toEqual([]);
          expect(lastStopPayload('azito:agent-1')?.reason).toBe('interrupted');
        } finally {
          vi.useRealTimers();
        }
      });

      it("synthesizes a 'completed' transition for a turn too short to be seen working", async () => {
        const completedAt = Date.now() - 1_000;
        monitor = makeMonitorWithProbe(async () => [{
          serverName: 'local', target: 'azito:agent-1', status: 'idle', completedAt, taskId: 42, label: 'agent-1',
        }]);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));

        await monitor.tick();
        await settleProbe();
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([]);
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
          type: 'agent:activity',
          payload: expect.objectContaining({
            target: 'azito:agent-1', running: false, reason: 'completed', taskId: 42,
          }),
        }));

        // The same completion must not be announced again on later ticks.
        emit.mockClear();
        await monitor.tick();
        expect(emit).not.toHaveBeenCalled();
      });

      it('does not synthesize a completion the probe reports as long past', async () => {
        monitor = makeMonitorWithProbe(async () => [{
          serverName: 'local', target: 'azito:agent-1', status: 'idle', completedAt: Date.now() - 10 * 60 * 1000,
        }]);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000) - 600));

        await monitor.tick();
        await settleProbe();
        emit.mockClear();
        await monitor.tick();
        expect(emit).not.toHaveBeenCalled();
      });

      it("labels a stop the Tier 3 heuristic merely aged out as 'unknown', never a completion", async () => {
        monitor = makeMonitorWithProbe(async () => []);
        findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
        const base = Math.floor(Date.now() / 1000);
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base, [makePane({ command: 'some-generic-tool' })]));
        await monitor.tick();
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base + 1, [makePane({ command: 'some-generic-tool' })]));
        await monitor.tick();
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base + 2, [makePane({ command: 'some-generic-tool' })]));
        await monitor.tick();
        expect(monitor.snapshot()).toEqual([expect.objectContaining({ running: true })]);

        emit.mockClear();
        listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, base - 600, [makePane({ command: 'some-generic-tool' })]));
        await monitor.tick();
        expect(lastStopPayload('azito:agent-1')?.reason).toBe('unknown');
      });
    });

    it('refreshes the probe at most once per PROCESS_PROBE_REFRESH_MS, not on every tick', async () => {
      const list = vi.fn().mockResolvedValue([]);
      monitor = makeMonitorWithProbe(list);
      findAll.mockReturnValue([makeWindow({ tmuxTarget: 'azito:agent-1.1', workerType: 'generic' })]);
      listSessions.mockResolvedValue(makeSessions('azito', 'agent-1', 3, Math.floor(Date.now() / 1000)));

      await monitor.tick();
      await settleProbe();
      await monitor.tick();
      await monitor.tick();
      expect(list).toHaveBeenCalledTimes(1);
    });
  });
});
