import { describe, it, expect } from 'vitest';
import { WindowInputService } from './WindowInputService';
import type { IWindowRepository, Window } from '../windows/Window';
import type { TmuxClient, TmuxPaneInfo } from '../tmux/TmuxClient';
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
  sshHostFingerprint: null,
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
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildPane(overrides: Partial<TmuxPaneInfo> = {}): TmuxPaneInfo {
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
  listAllPanes?: TmuxClient['listAllPanes'];
  sendLiteralText?: TmuxClient['sendLiteralText'];
  sendKeys?: TmuxClient['sendKeys'];
  servers?: ServerConfig[];
} = {}) {
  const windowRepo = {
    findById: opts.findById ?? (() => buildWindow()),
  } as unknown as IWindowRepository;

  const calls: { sendLiteralText: unknown[]; sendKeys: unknown[]; wait: number[] } = { sendLiteralText: [], sendKeys: [], wait: [] };

  const tmuxClient = {
    listAllPanes: opts.listAllPanes ?? (async () => [buildPane()]),
    sendLiteralText: opts.sendLiteralText ?? (async (...args: unknown[]) => { calls.sendLiteralText.push(args); }),
    sendKeys: opts.sendKeys ?? (async (...args: unknown[]) => { calls.sendKeys.push(args); }),
  } as unknown as TmuxClient;

  const serverRepo = {
    findByName: (name: string) => (opts.servers ?? [LOCAL_SERVER]).find((s) => s.name === name) ?? null,
  } as unknown as IServerRepository;

  // 実タイマーを使わず呼び出し記録だけ行う注入用 wait 関数。順序検証のため
  // sendLiteralText/sendKeys と同じ calls オブジェクトに 'wait:<ms>' を積む。
  const wait = async (ms: number) => { calls.wait.push(ms); };

  return { windowRepo, tmuxClient, serverRepo, calls, wait };
}

describe('WindowInputService', () => {
  describe('sendInput', () => {
    it('returns window_not_found when the window does not exist', async () => {
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({ findById: () => undefined });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendInput(42, '%1', 'hello');
      expect(result).toBe('window_not_found');
    });

    it('returns window_not_found when the window\'s server no longer exists', async () => {
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({ servers: [] });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendInput(42, '%1', 'hello');
      expect(result).toBe('window_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({ listAllPanes: async () => [] });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendInput(42, '%1', 'hello');
      expect(result).toBe('pane_not_found');
    });

    it('returns pane_not_found when the pane exists but belongs to a different window (cross-window attack)', async () => {
      // paneId '%1' is real, but lives in session "other", window 0 — not the target window "main:0".
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({
        listAllPanes: async () => [buildPane({ paneId: '%1', sessionName: 'other', windowIndex: 0 })],
      });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendInput(42, '%1', 'hello');
      expect(result).toBe('pane_not_found');
    });

    it('sends literal text followed by Enter and returns ok', async () => {
      const { windowRepo, tmuxClient, serverRepo, calls, wait } = buildDeps();
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo, wait);
      const result = await service.sendInput(42, '%1', 'echo hello');
      expect(result).toBe('ok');
      expect(calls.sendLiteralText).toEqual([[LOCAL_SERVER, '%1', 'echo hello']]);
      expect(calls.sendKeys).toEqual([[LOCAL_SERVER, '%1', ['Enter']]]);
    });

    it('does not wait before Enter for workerType "claude" (no submitDelayMs)', async () => {
      const { windowRepo, tmuxClient, serverRepo, calls, wait } = buildDeps({ findById: () => buildWindow({ workerType: 'claude' }) });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo, wait);
      await service.sendInput(42, '%1', 'echo hello');
      expect(calls.wait).toEqual([]);
    });

    it('waits the codex submitDelayMs between literal text and Enter (Ink TUI drops Enter sent too early)', async () => {
      const order: string[] = [];
      const { windowRepo, serverRepo } = buildDeps({ findById: () => buildWindow({ workerType: 'codex' }) });
      const tmuxClient = {
        listAllPanes: async () => [buildPane()],
        sendLiteralText: async () => { order.push('sendLiteralText'); },
        sendKeys: async () => { order.push('sendKeys'); },
      } as unknown as TmuxClient;
      const wait = async (ms: number) => { order.push(`wait:${ms}`); };
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo, wait);
      const result = await service.sendInput(42, '%1', 'reply with OK only');
      expect(result).toBe('ok');
      expect(order).toEqual(['sendLiteralText', 'wait:200', 'sendKeys']);
    });
  });

  describe('sendSignal', () => {
    it('returns window_not_found when the window does not exist', async () => {
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({ findById: () => undefined });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'interrupt');
      expect(result).toBe('window_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({ listAllPanes: async () => [] });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'interrupt');
      expect(result).toBe('pane_not_found');
    });

    it('returns pane_not_found when the pane exists but belongs to a different window (cross-window attack)', async () => {
      const { windowRepo, tmuxClient, serverRepo } = buildDeps({
        listAllPanes: async () => [buildPane({ paneId: '%1', sessionName: 'other', windowIndex: 0 })],
      });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'interrupt');
      expect(result).toBe('pane_not_found');
    });

    it('resolves the interrupt key from the workerType profile (claude -> Escape)', async () => {
      const { windowRepo, tmuxClient, serverRepo, calls } = buildDeps({ findById: () => buildWindow({ workerType: 'claude' }) });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'interrupt');
      expect(result).toBe('ok');
      expect(calls.sendKeys).toEqual([[LOCAL_SERVER, '%1', ['Escape']]]);
    });

    it('defaults to C-c when workerType has no transcript profile (e.g. generic)', async () => {
      const { windowRepo, tmuxClient, serverRepo, calls } = buildDeps({ findById: () => buildWindow({ workerType: 'generic' }) });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'interrupt');
      expect(result).toBe('ok');
      expect(calls.sendKeys).toEqual([[LOCAL_SERVER, '%1', ['C-c']]]);
    });

    it('defaults to C-c when workerType is null (plain terminal window)', async () => {
      const { windowRepo, tmuxClient, serverRepo, calls } = buildDeps({ findById: () => buildWindow({ workerType: null }) });
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'interrupt');
      expect(result).toBe('ok');
      expect(calls.sendKeys).toEqual([[LOCAL_SERVER, '%1', ['C-c']]]);
    });

    it('sends the explicitly given key for action:"key"', async () => {
      const { windowRepo, tmuxClient, serverRepo, calls } = buildDeps();
      const service = new WindowInputService(windowRepo, tmuxClient, serverRepo);
      const result = await service.sendSignal(42, '%1', 'key', 'C-c');
      expect(result).toBe('ok');
      expect(calls.sendKeys).toEqual([[LOCAL_SERVER, '%1', ['C-c']]]);
    });
  });
});
