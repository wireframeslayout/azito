import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle, type MuxPaneInfo } from '@azito/shared';
import { WindowInputService } from './WindowInputService';
import type { IWindowRepository, Window } from '../windows/Window';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IServerRepository, ServerConfig } from '../servers/Server';

const LOCAL_SERVER: ServerConfig = {
  name: 'local',
  type: 'local',
  host: null,
  agentPort: null,
  agentToken: null,
  agentVersion: null,
  sshHost: null,
  muxRuntime: 'system',
  herdrNavigationLock: 'locked' as const,
  sshHostFingerprint: null,
  isolationIntent: false,
  isolationVerifiedAt: null,
  isolationReport: null, isolationCleanupReport: null,
  createdAt: '2026-01-01T00:00:00Z',
};

function buildWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 42,
    ownerType: 'task',
    projectId: 1,
    taskId: null,
    serverName: 'local',
    tmuxTarget: 'main:0',
    label: null,
    isPrimary: true,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    sleeping: false,
    herdrNavigationLock: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildPane(overrides: Partial<MuxPaneInfo> = {}): MuxPaneInfo {
  return {
    paneId: '%1',
    sessionName: 'main',
    windowIndex: 0,
    windowName: 'agent',
    paneIndex: 0,
    currentPath: '/tmp',
    currentCommand: 'claude',
    ...overrides,
  };
}

function buildDeps(opts: {
  findById?: IWindowRepository['findById'];
  listAllPanes?: IMuxClient['listAllPanes'];
  sendTextToHandle?: IMuxClient['sendTextToHandle'];
  sendKeysToHandle?: IMuxClient['sendKeysToHandle'];
  isPaneInModeByHandle?: IMuxClient['isPaneInModeByHandle'];
  copyMode?: boolean;
  servers?: ServerConfig[];
} = {}) {
  const windowRepo = {
    findById: opts.findById ?? (() => buildWindow()),
  } as unknown as IWindowRepository;

  const calls: { sendTextToHandle: unknown[]; sendKeysToHandle: unknown[]; wait: number[]; cancelPaneModeByHandle: unknown[] } =
    { sendTextToHandle: [], sendKeysToHandle: [], wait: [], cancelPaneModeByHandle: [] };

  const driver = {
    caps: { copyMode: opts.copyMode ?? true },
    listAllPanes: opts.listAllPanes ?? (async () => [buildPane()]),
    sendTextToHandle: opts.sendTextToHandle ?? (async (...args: unknown[]) => { calls.sendTextToHandle.push(args); }),
    sendKeysToHandle: opts.sendKeysToHandle ?? (async (...args: unknown[]) => { calls.sendKeysToHandle.push(args); }),
    isPaneInModeByHandle: opts.isPaneInModeByHandle ?? (async () => false),
    cancelPaneModeByHandle: async (...args: unknown[]) => { calls.cancelPaneModeByHandle.push(args); },
  } as unknown as IMuxClient;

  const muxDriverRegistry = { resolve: () => driver } as unknown as MuxDriverRegistry;

  const serverRepo = {
    findByName: (name: string) => (opts.servers ?? [LOCAL_SERVER]).find((s) => s.name === name) ?? null,
  } as unknown as IServerRepository;

  const wait = async (ms: number) => { calls.wait.push(ms); };

  return { windowRepo, muxDriverRegistry, serverRepo, calls, wait };
}

describe('WindowInputService', () => {
  describe('sendInput', () => {
    it('returns window_not_found when the window does not exist', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({ findById: () => undefined });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'hello');
      expect(result).toBe('window_not_found');
    });

    it('returns window_not_found when the window\'s server no longer exists', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({ servers: [] });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'hello');
      expect(result).toBe('window_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({ listAllPanes: async () => [] });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'hello');
      expect(result).toBe('pane_not_found');
    });

    it('returns pane_not_found when the pane exists but belongs to a different window (cross-window attack)', async () => {
      // paneId '%1' is real, but lives in session "other", window 0 — not the target window "main:0".
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({
        listAllPanes: async () => [buildPane({ paneId: '%1', sessionName: 'other', windowIndex: 0 })],
      });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'hello');
      expect(result).toBe('pane_not_found');
    });

    it('sends literal text followed by Enter and returns ok', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls, wait } = buildDeps();
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo, wait);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'echo hello');
      expect(result).toBe('ok');
      expect(calls.sendTextToHandle).toEqual([[LOCAL_SERVER, '%1', 'echo hello']]);
      expect(calls.sendKeysToHandle).toEqual([[LOCAL_SERVER, '%1', ['Enter']]]);
    });

    it('does not wait before Enter for workerType "claude" (no submitDelayMs)', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls, wait } = buildDeps({ findById: () => buildWindow({ workerType: 'claude' }) });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo, wait);
      await service.sendInput(42, asPaneHandle('%1'), 'echo hello');
      expect(calls.wait).toEqual([]);
    });

    it('waits the codex submitDelayMs between literal text and Enter (Ink TUI drops Enter sent too early)', async () => {
      const order: string[] = [];
      const { windowRepo, serverRepo } = buildDeps({ findById: () => buildWindow({ workerType: 'codex' }) });
      const driver = {
        caps: { copyMode: true },
        listAllPanes: async () => [buildPane()],
        sendTextToHandle: async () => { order.push('sendTextToHandle'); },
        sendKeysToHandle: async () => { order.push('sendKeysToHandle'); },
        isPaneInModeByHandle: async () => false,
        cancelPaneModeByHandle: async () => { order.push('cancelPaneModeByHandle'); },
      } as unknown as IMuxClient;
      const registry = { resolve: () => driver } as unknown as MuxDriverRegistry;
      const wait = async (ms: number) => { order.push(`wait:${ms}`); };
      const service = new WindowInputService(windowRepo, registry, serverRepo, wait);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'reply with OK only');
      expect(result).toBe('ok');
      expect(order).toEqual(['sendTextToHandle', 'wait:200', 'sendKeysToHandle']);
    });

    it('cancels copy-mode before sending when the pane is in_mode (Issue #69 T12)', async () => {
      const order: string[] = [];
      const { windowRepo, serverRepo } = buildDeps();
      const driver = {
        caps: { copyMode: true },
        listAllPanes: async () => [buildPane()],
        isPaneInModeByHandle: async () => true,
        cancelPaneModeByHandle: async () => { order.push('cancelPaneModeByHandle'); },
        sendTextToHandle: async () => { order.push('sendTextToHandle'); },
        sendKeysToHandle: async () => { order.push('sendKeysToHandle'); },
      } as unknown as IMuxClient;
      const registry = { resolve: () => driver } as unknown as MuxDriverRegistry;
      const wait = async (ms: number) => { order.push(`wait:${ms}`); };
      const service = new WindowInputService(windowRepo, registry, serverRepo, wait);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'echo hello');
      expect(result).toBe('ok');
      expect(order).toEqual(['cancelPaneModeByHandle', 'wait:100', 'sendTextToHandle', 'sendKeysToHandle']);
    });

    it('does not cancel copy-mode when the pane is not in_mode', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ isPaneInModeByHandle: async () => false });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'echo hello');
      expect(result).toBe('ok');
      expect(calls.cancelPaneModeByHandle).toEqual([]);
    });

    it('skips copy-mode check entirely when caps.copyMode is false (herdr/zellij)', async () => {
      const isPaneInModeByHandle = vi.fn(async () => true);
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ isPaneInModeByHandle, copyMode: false });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(42, asPaneHandle('%1'), 'echo hello');
      expect(result).toBe('ok');
      expect(isPaneInModeByHandle).not.toHaveBeenCalled();
      expect(calls.cancelPaneModeByHandle).toEqual([]);
    });
  });

  describe('sendSignal', () => {
    it('returns window_not_found when the window does not exist', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({ findById: () => undefined });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('window_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({ listAllPanes: async () => [] });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('pane_not_found');
    });

    it('returns pane_not_found when the pane exists but belongs to a different window (cross-window attack)', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({
        listAllPanes: async () => [buildPane({ paneId: '%1', sessionName: 'other', windowIndex: 0 })],
      });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('pane_not_found');
    });

    it('resolves the interrupt key from the workerType profile (claude -> Escape)', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ findById: () => buildWindow({ workerType: 'claude' }) });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('ok');
      expect(calls.sendKeysToHandle).toEqual([[LOCAL_SERVER, '%1', ['Escape']]]);
    });

    it('defaults to C-c when workerType has no transcript profile (e.g. generic)', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ findById: () => buildWindow({ workerType: 'generic' }) });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('ok');
      expect(calls.sendKeysToHandle).toEqual([[LOCAL_SERVER, '%1', ['C-c']]]);
    });

    it('defaults to C-c when workerType is null (plain terminal window)', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ findById: () => buildWindow({ workerType: null }) });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('ok');
      expect(calls.sendKeysToHandle).toEqual([[LOCAL_SERVER, '%1', ['C-c']]]);
    });

    it('sends the explicitly given key for action:"key"', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps();
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'key', 'C-c');
      expect(result).toBe('ok');
      expect(calls.sendKeysToHandle).toEqual([[LOCAL_SERVER, '%1', ['C-c']]]);
    });

    it('cancels copy-mode before sending the signal when the pane is in_mode (Issue #69 T12)', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ isPaneInModeByHandle: async () => true });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('ok');
      expect(calls.cancelPaneModeByHandle).toEqual([[LOCAL_SERVER, '%1']]);
    });

    it('does not cancel copy-mode when the pane is not in_mode', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo, calls } = buildDeps({ isPaneInModeByHandle: async () => false });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(42, asPaneHandle('%1'), 'interrupt');
      expect(result).toBe('ok');
      expect(calls.cancelPaneModeByHandle).toEqual([]);
    });
  });
  describe('resolvePaneIndex', () => {
    it('paneId に対応する tmux ペイン index を返す', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({
        listAllPanes: async () => [buildPane({ paneId: '%1', paneIndex: 0 }), buildPane({ paneId: '%2', paneIndex: 3 })],
      });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      expect(await service.resolvePaneIndex(42, asPaneHandle('%2'))).toBe(3);
    });

    it('ウィンドウが無ければ window_not_found', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({ findById: () => undefined });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      expect(await service.resolvePaneIndex(42, asPaneHandle('%1'))).toBe('window_not_found');
    });

    it('別ウィンドウのペインは pane_not_found（帰属していない paneId を index へ解決しない）', async () => {
      const { windowRepo, muxDriverRegistry, serverRepo } = buildDeps({
        listAllPanes: async () => [buildPane({ paneId: '%9', sessionName: 'other', windowIndex: 7 })],
      });
      const service = new WindowInputService(windowRepo, muxDriverRegistry, serverRepo);
      expect(await service.resolvePaneIndex(42, asPaneHandle('%9'))).toBe('pane_not_found');
    });
  });
});
