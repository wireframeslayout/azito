import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityTracker } from './ActivityTracker';
import { TitleStateTracker } from './TitleStateTracker';

describe('ActivityTracker', () => {
  let tracker: ActivityTracker;
  let transitions: Array<{ state: string; bytes: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new ActivityTracker({
      windowMs: 3_000,
      activeThresholdBytes: 200,
      idleAfterMs: 10_000,
      tickMs: 1_000,
    });
    transitions = [];
    tracker.on('transition', (state: string, bytes: number) => {
      transitions.push({ state, bytes });
    });
    tracker.start();
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  it('stays idle below the byte threshold', () => {
    tracker.record(100);
    vi.advanceTimersByTime(3_000);
    expect(transitions).toEqual([]);
    expect(tracker.getState()).toBe('idle');
  });

  it('transitions to active when the window sum reaches the threshold', () => {
    tracker.record(150);
    tracker.record(100);
    vi.advanceTimersByTime(1_000);
    expect(transitions).toEqual([{ state: 'active', bytes: 250 }]);
    expect(tracker.getState()).toBe('active');
  });

  it('does not go active from a repaint burst within the resize grace', () => {
    tracker.notifyResize(); // browser attach → SIGWINCH → full repaint incoming
    tracker.record(5_000); // large repaint burst, but during the grace
    vi.advanceTimersByTime(1_000);
    expect(transitions).toEqual([]);
    expect(tracker.getState()).toBe('idle');
  });

  it('counts real output again once the resize grace has elapsed', () => {
    tracker.notifyResize();
    tracker.record(5_000); // graced repaint — ignored
    vi.advanceTimersByTime(900); // past the 800ms grace
    tracker.record(250); // genuine output afterwards
    vi.advanceTimersByTime(1_000);
    expect(transitions).toEqual([{ state: 'active', bytes: 250 }]);
    expect(tracker.getState()).toBe('active');
  });

  it('emits the transition only once (no repeat while continuously active)', () => {
    tracker.record(500);
    vi.advanceTimersByTime(1_000);
    tracker.record(500);
    vi.advanceTimersByTime(2_000);
    expect(transitions.filter((t) => t.state === 'active')).toHaveLength(1);
  });

  it('transitions to idle after idleAfterMs below the threshold', () => {
    tracker.record(500);
    vi.advanceTimersByTime(1_000);
    expect(tracker.getState()).toBe('active');
    // Silence: idle requires idleAfterMs of ticks whose window sum is below the
    // active threshold, measured from the last above-threshold tick (the 500B
    // sample keeps the 3s window above threshold until t=3s).
    vi.advanceTimersByTime(13_000);
    expect(tracker.getState()).toBe('idle');
    expect(transitions.at(-1)).toEqual({ state: 'idle', bytes: 0 });
  });

  it('goes idle even while a sub-threshold trickle keeps dribbling out', () => {
    tracker.record(500);
    vi.advanceTimersByTime(1_000);
    expect(tracker.getState()).toBe('active');
    // An idle TUI still emits a few bytes (cursor blink / prompt redraw). A
    // trickle that never reaches the threshold must NOT postpone idle: idle is
    // keyed off the last above-threshold tick, not the last byte.
    for (let i = 0; i < 12; i += 1) {
      tracker.record(10);
      vi.advanceTimersByTime(1_000);
    }
    expect(tracker.getState()).toBe('idle');
  });

  it('stays active while output keeps exceeding the threshold', () => {
    tracker.record(500);
    vi.advanceTimersByTime(1_000);
    // Sustained real work: 300 bytes/s keeps the 3s window sum above 200.
    for (let i = 0; i < 8; i += 1) {
      tracker.record(300);
      vi.advanceTimersByTime(1_000);
    }
    expect(tracker.getState()).toBe('active');
  });

  it('re-emits active every 15s while active', () => {
    tracker.record(500);
    vi.advanceTimersByTime(1_000);
    expect(transitions.filter((t) => t.state === 'active')).toHaveLength(1);
    // Keep it active with periodic large output.
    for (let i = 0; i < 30; i += 1) {
      tracker.record(300);
      vi.advanceTimersByTime(1_000);
    }
    // 31s elapsed since first emit -> 2 re-sends (at ~16s and ~31s).
    const actives = transitions.filter((t) => t.state === 'active');
    expect(actives.length).toBe(3);
  });

  describe('title mode (title state takes over from the byte heuristic)', () => {
    let statusLog: Array<{ state: string; status?: string }>;

    beforeEach(() => {
      statusLog = [];
      tracker.on('transition', (state: string, _bytes: number, status?: 'working' | 'blocked') => {
        statusLog.push({ state, status });
      });
    });

    it('goes active with status working on a working title, without any byte volume', () => {
      tracker.setTitleState('working');
      vi.advanceTimersByTime(1_000);
      expect(tracker.getState()).toBe('active');
      expect(statusLog).toEqual([{ state: 'active', status: 'working' }]);
    });

    it('stays idle on an idle title even while byte volume exceeds the active threshold (keystroke-echo false positive)', () => {
      // Core regression case: Claude Code's TUI repaints its input box on
      // every keypress — hundreds of bytes per keystroke while the agent is
      // actually idle. Once the idle title is observed, that volume must be
      // ignored entirely.
      tracker.setTitleState('idle');
      for (let i = 0; i < 5; i += 1) {
        tracker.record(1_000);
        vi.advanceTimersByTime(1_000);
      }
      expect(tracker.getState()).toBe('idle');
      expect(statusLog).toEqual([]);
    });

    it('maps a blocked title to active with status blocked, and emits on a working→blocked flip', () => {
      tracker.setTitleState('working');
      vi.advanceTimersByTime(1_000);
      tracker.setTitleState('blocked');
      vi.advanceTimersByTime(1_000);
      expect(statusLog).toEqual([
        { state: 'active', status: 'working' },
        { state: 'active', status: 'blocked' },
      ]);
    });

    it('transitions active→idle immediately when the title flips to idle (no idleAfterMs wait)', () => {
      tracker.setTitleState('working');
      vi.advanceTimersByTime(1_000);
      tracker.setTitleState('idle');
      vi.advanceTimersByTime(1_000);
      expect(tracker.getState()).toBe('idle');
      expect(statusLog.at(-1)).toEqual({ state: 'idle', status: undefined });
    });

    it('ignores a later unknown title state (title mode is sticky once entered)', () => {
      tracker.setTitleState('working');
      vi.advanceTimersByTime(1_000);
      tracker.setTitleState('unknown');
      vi.advanceTimersByTime(1_000);
      expect(tracker.getState()).toBe('active');
    });

    it('falls back to the byte heuristic while no title has ever been observed', () => {
      tracker.setTitleState('unknown');
      tracker.record(500);
      vi.advanceTimersByTime(1_000);
      expect(tracker.getState()).toBe('active');
      expect(statusLog).toEqual([{ state: 'active', status: undefined }]);
    });

    // Issue #338: wired exactly as main.ts does (push the PTY chunk into the
    // title tracker, then hand its state to the activity tracker).
    describe('wired to TitleStateTracker', () => {
      const feed = (titleTracker: TitleStateTracker, chunk: string, bytes = 0) => {
        titleTracker.push(chunk);
        if (bytes > 0) tracker.record(bytes);
        tracker.setTitleState(titleTracker.getState());
      };

      it('keeps the byte heuristic alive for a TUI that only sets a static, unrecognized title', () => {
        const titleTracker = new TitleStateTracker();
        for (let i = 0; i < 3; i += 1) {
          feed(titleTracker, '\x1b]2;my-tui\x07', 500);
          vi.advanceTimersByTime(1_000);
        }
        expect(tracker.getState()).toBe('active');
        expect(statusLog).toEqual([{ state: 'active', status: undefined }]);
      });

      it('hands authority to the title once a recognized marker appears', () => {
        const titleTracker = new TitleStateTracker();
        feed(titleTracker, '\x1b]2;my-tui\x07', 500);
        vi.advanceTimersByTime(1_000);
        expect(tracker.getState()).toBe('active'); // byte heuristic

        feed(titleTracker, '\x1b]2;✳ done\x07', 500);
        vi.advanceTimersByTime(1_000);
        expect(tracker.getState()).toBe('idle'); // title authority, byte volume ignored
        expect(statusLog.at(-1)).toEqual({ state: 'idle', status: undefined });
      });
    });

    it('re-emits active with its status every 15s while the title stays working', () => {
      tracker.setTitleState('working');
      vi.advanceTimersByTime(31_000);
      const actives = statusLog.filter((t) => t.state === 'active');
      expect(actives.length).toBe(3);
      expect(actives.every((t) => t.status === 'working')).toBe(true);
    });
  });
});
