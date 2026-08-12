import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionMonitor, type InteractionSignal } from './InteractionMonitor';
import type { IWindowRepository, Window } from '../windows/Window';

function makeWindow(overrides: Partial<Window> = {}): Window {
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

function makeSignal(overrides: Partial<InteractionSignal> = {}): InteractionSignal {
  return {
    serverName: 'local',
    target: { sessionName: 'azito', windowIndex: 1, windowName: 'agent-1', paneIndex: 1 },
    event: 'open',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('InteractionMonitor', () => {
  let findAll: ReturnType<typeof vi.fn<() => Window[]>>;
  let findById: ReturnType<typeof vi.fn<(id: number) => Window | undefined>>;
  let now: ReturnType<typeof vi.fn<() => number>>;
  let monitor: InteractionMonitor;

  beforeEach(() => {
    findAll = vi.fn<() => Window[]>().mockReturnValue([makeWindow()]);
    findById = vi.fn<(id: number) => Window | undefined>().mockReturnValue(makeWindow());
    now = vi.fn<() => number>().mockReturnValue(1_000_000);
    monitor = new InteractionMonitor(
      { findAll, findById } as unknown as IWindowRepository,
      now,
    );
  });

  it('is not pending before any signal', () => {
    expect(monitor.isPending(1)).toBe(false);
  });

  it('open -> pending, resolved against the windows table', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);
  });

  it('is ignored when window resolution fails (no matching window)', () => {
    findAll.mockReturnValue([]);
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('is ignored when the signal names a different server', () => {
    monitor.recordSignal(makeSignal({ serverName: 'other', timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('is ignored when the pane suffix does not match', () => {
    monitor.recordSignal(makeSignal({ target: { sessionName: 'azito', windowIndex: 1, windowName: 'agent-1', paneIndex: 2 }, timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('times out after 10 minutes', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    now.mockReturnValue(1_000_000 + 10 * 60 * 1000 - 1);
    expect(monitor.isPending(1)).toBe(true);

    now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
    expect(monitor.isPending(1)).toBe(false);
  });

  it('clear() authoritatively closes a pending signal', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    monitor.clear(1);
    expect(monitor.isPending(1)).toBe(false);
  });

  it('a cancel signal closes a pending open', () => {
    monitor.recordSignal(makeSignal({ event: 'open', timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    monitor.recordSignal(makeSignal({ event: 'cancel', timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('is not pending once the window disappears from the windows table', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    findById.mockReturnValue(undefined);
    expect(monitor.isPending(1)).toBe(false);
  });

  describe('getOpenedAt', () => {
    it('is undefined before any signal', () => {
      expect(monitor.getOpenedAt(1)).toBeUndefined();
    });

    it('returns the signal timestamp while pending', () => {
      monitor.recordSignal(makeSignal({ timestamp: 1_000_000 }));
      expect(monitor.getOpenedAt(1)).toBe(1_000_000);
    });

    it('is undefined after clear()', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      monitor.clear(1);
      expect(monitor.getOpenedAt(1)).toBeUndefined();
    });

    it('is undefined after timeout, mirroring isPending', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
      expect(monitor.getOpenedAt(1)).toBeUndefined();
    });
  });
});
