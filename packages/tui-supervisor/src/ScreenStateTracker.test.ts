import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenStateTracker } from './ScreenStateTracker';

describe('ScreenStateTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function pushAndFlush(tracker: ScreenStateTracker, chunk: string): void {
    tracker.push(chunk);
    // xterm's write callback fires asynchronously; advance timers to let it run,
    // then advance again for the debounce timer.
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(300);
  }

  it('starts in unknown state', () => {
    const tracker = new ScreenStateTracker('claude');
    expect(tracker.getState()).toBe('unknown');
    tracker.dispose();
  });

  it('classifies a prompt box as idle', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);
    const changes: string[] = [];
    tracker.onChange((s) => changes.push(s));

    const screen = [
      'some output',
      '──────────────────────────────────────────────────────────────────────────────',
      '  ❯ ',
      '──────────────────────────────────────────────────────────────────────────────',
    ].join('\r\n');
    pushAndFlush(tracker, screen);

    expect(tracker.getState()).toBe('idle');
    expect(changes).toContain('idle');
    tracker.dispose();
  });

  it('classifies esc to interrupt as working', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);
    const changes: string[] = [];
    tracker.onChange((s) => changes.push(s));

    const screen = [
      '  ⏵⏵ Reading file… esc to interrupt',
      '──────────────────────────────────────────────────────────────────────────────',
      '  ❯ ',
      '──────────────────────────────────────────────────────────────────────────────',
    ].join('\r\n');
    pushAndFlush(tracker, screen);

    expect(tracker.getState()).toBe('working');
    tracker.dispose();
  });

  it('classifies enter to select + esc to cancel as blocked', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);
    const changes: string[] = [];
    tracker.onChange((s) => changes.push(s));

    const screen = [
      '  Choose an option:',
      '  ❯ 1. Yes',
      '    2. No',
      '  enter to select · esc to cancel',
      '──────────────────────────────────────────────────────────────────────────────',
      '  ❯ ',
      '──────────────────────────────────────────────────────────────────────────────',
    ].join('\r\n');
    pushAndFlush(tracker, screen);

    expect(tracker.getState()).toBe('blocked');
    tracker.dispose();
  });

  it('does not fire onChange when state stays the same', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);
    const changes: string[] = [];
    tracker.onChange((s) => changes.push(s));

    const screen = [
      '──────────────────────────────────────────────────────────────────────────────',
      '  ❯ ',
      '──────────────────────────────────────────────────────────────────────────────',
    ].join('\r\n');
    pushAndFlush(tracker, screen);
    pushAndFlush(tracker, screen);

    expect(changes.filter((s) => s === 'idle')).toHaveLength(1);
    tracker.dispose();
  });

  it('preserves state on skip (transcript viewer)', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);

    // First establish a working state
    const working = [
      '  ⏵⏵ Reading file… esc to interrupt',
      '──────────────────────────────────────────────────────────────────────────────',
      '  ❯ ',
      '──────────────────────────────────────────────────────────────────────────────',
    ].join('\r\n');
    pushAndFlush(tracker, working);
    expect(tracker.getState()).toBe('working');

    // Then a transcript viewer screen → skip → state should stay working
    const transcript = [
      'Showing detailed transcript for session abc',
    ].join('\r\n');
    pushAndFlush(tracker, '\x1b[2J\x1b[H' + transcript);
    expect(tracker.getState()).toBe('working');
    tracker.dispose();
  });

  it('handles resize', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);
    // Should not throw
    tracker.resize(120, 50);
    tracker.dispose();
  });

  it('works with codex rules', () => {
    const tracker = new ScreenStateTracker('codex', 80, 24);
    const changes: string[] = [];
    tracker.onChange((s) => changes.push(s));

    pushAndFlush(tracker, 'Allow command?\r\n');
    expect(tracker.getState()).toBe('blocked');
    tracker.dispose();
  });

  it('cleans up on dispose', () => {
    const tracker = new ScreenStateTracker('claude', 80, 24);
    tracker.push('test data');
    tracker.dispose();
    // Should not throw after dispose
    expect(tracker.getState()).toBe('unknown');
  });
});
