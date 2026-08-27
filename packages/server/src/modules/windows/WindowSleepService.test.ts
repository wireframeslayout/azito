import { describe, it, expect, vi } from 'vitest';
import { WindowSleepService } from './WindowSleepService';
import type { Window, IWindowRepository } from './Window';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { IServerRepository, ServerConfig } from '../servers/Server';

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1,
    ownerType: 'task',
    projectId: null,
    taskId: 1,
    serverName: 'local-server',
    tmuxTarget: 'azito:task-1.1',
    label: 'task-1',
    isPrimary: true,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: 'session-uuid-1',
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    sleeping: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'local-server',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
    isolationCleanupReport: null,
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildService(overrides: {
  windows?: Window[];
  server?: ServerConfig | null;
  supportsSessionMap?: Record<string, boolean>;
} = {}) {
  const windows = overrides.windows ?? [makeWindow()];
  const server = overrides.server !== undefined ? overrides.server : makeServer();
  const supportsSessionMap = overrides.supportsSessionMap ?? {};

  const windowRepo: Partial<IWindowRepository> = {
    findById: vi.fn((id: number) => windows.find((w) => w.id === id)),
    findByTask: vi.fn((taskId: number) => windows.filter((w) => w.taskId === taskId)),
    update: vi.fn(),
  };

  const killWindow = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  const tmux: Partial<TmuxClient> = { killWindow: killWindow as unknown as TmuxClient['killWindow'] };

  const sessionStrategyFactory: ISessionStrategyFactory = {
    create: (workerType: string | null) => ({
      supportsSession: supportsSessionMap[workerType ?? ''] ?? (workerType !== 'generic'),
      needsPostLaunchScan: false,
      buildNewSessionFlags: () => '',
      buildResumeFlags: () => '',
      buildRespawnCommand: () => null,
      scanSessionId: vi.fn().mockResolvedValue(null),
    }),
  };

  const serverRepo: Partial<IServerRepository> = {
    findByName: vi.fn((name: string) => (server && name === server.name ? server : null)),
  };

  const service = new WindowSleepService(
    windowRepo as IWindowRepository,
    tmux as TmuxClient,
    sessionStrategyFactory,
    serverRepo as IServerRepository,
  );

  return { service, windowRepo, tmux, killWindow, serverRepo };
}

describe('WindowSleepService', () => {
  describe('canSleep', () => {
    it('returns false for a terminal window', () => {
      const { service } = buildService({ windows: [makeWindow({ windowType: 'terminal', workerType: null })] });
      expect(service.canSleep(makeWindow({ windowType: 'terminal', workerType: null }))).toBe(false);
    });

    it('returns false when agentSessionId is null', () => {
      const { service } = buildService();
      expect(service.canSleep(makeWindow({ agentSessionId: null }))).toBe(false);
    });

    it('returns false when supportsSession is false (generic worker)', () => {
      const { service } = buildService({ supportsSessionMap: { generic: false } });
      expect(service.canSleep(makeWindow({ workerType: 'generic' }))).toBe(false);
    });

    it('returns false when already sleeping', () => {
      const { service } = buildService();
      expect(service.canSleep(makeWindow({ sleeping: true }))).toBe(false);
    });

    it('returns true for a normal agent window with agentSessionId and supportsSession', () => {
      const { service } = buildService();
      expect(service.canSleep(makeWindow())).toBe(true);
    });
  });

  describe('sleep', () => {
    it('calls tmux.killWindow and windowRepo.update({sleeping: true})', async () => {
      const win = makeWindow();
      const { service, killWindow, windowRepo } = buildService({ windows: [win] });

      await service.sleep(win.id);

      expect(killWindow).toHaveBeenCalledTimes(1);
      expect(killWindow).toHaveBeenCalledWith(expect.objectContaining({ name: 'local-server' }), 'azito:task-1');
      expect(windowRepo.update).toHaveBeenCalledWith(win.id, { sleeping: true });
    });

    it('throws when canSleep returns false', async () => {
      const win = makeWindow({ agentSessionId: null });
      const { service } = buildService({ windows: [win] });

      await expect(service.sleep(win.id)).rejects.toThrow('Window cannot be put to sleep');
    });

    it('throws when window is not found', async () => {
      const { service } = buildService({ windows: [] });

      await expect(service.sleep(999)).rejects.toThrow('Window not found');
    });

    it('sets sleeping: true even when killWindow fails', async () => {
      const win = makeWindow();
      const { service, killWindow, windowRepo } = buildService({ windows: [win] });
      killWindow.mockRejectedValue(new Error('tmux error'));

      await service.sleep(win.id);

      expect(killWindow).toHaveBeenCalledTimes(1);
      expect(windowRepo.update).toHaveBeenCalledWith(win.id, { sleeping: true });
    });

    it('sets sleeping: true even when server is not found (window may have been on a removed server)', async () => {
      const win = makeWindow();
      const { service, killWindow, windowRepo } = buildService({ windows: [win], server: null });

      await service.sleep(win.id);

      expect(killWindow).not.toHaveBeenCalled();
      expect(windowRepo.update).toHaveBeenCalledWith(win.id, { sleeping: true });
    });
  });

  describe('sleepTaskWindows', () => {
    it('sleeps all canSleep windows for a task and returns their IDs', async () => {
      const win1 = makeWindow({ id: 1, taskId: 5 });
      const win2 = makeWindow({ id: 2, taskId: 5, tmuxTarget: 'azito:task-2.1' });
      const { service, windowRepo } = buildService({ windows: [win1, win2] });

      const result = await service.sleepTaskWindows(5);

      expect(result).toEqual([1, 2]);
      expect(windowRepo.update).toHaveBeenCalledTimes(2);
    });

    it('skips windows that cannot sleep', async () => {
      const sleepable = makeWindow({ id: 1, taskId: 5 });
      const terminal = makeWindow({ id: 2, taskId: 5, windowType: 'terminal', workerType: null });
      const noSession = makeWindow({ id: 3, taskId: 5, agentSessionId: null });
      const { service, windowRepo } = buildService({ windows: [sleepable, terminal, noSession] });

      const result = await service.sleepTaskWindows(5);

      expect(result).toEqual([1]);
      expect(windowRepo.update).toHaveBeenCalledTimes(1);
    });

    it('continues sleeping other windows when one fails', async () => {
      const win1 = makeWindow({ id: 1, taskId: 5 });
      const win2 = makeWindow({ id: 2, taskId: 5, tmuxTarget: 'azito:task-2.1' });
      const { service, killWindow, windowRepo } = buildService({ windows: [win1, win2] });
      killWindow.mockRejectedValueOnce(new Error('kill failed'));

      const result = await service.sleepTaskWindows(5);

      expect(result).toEqual([1, 2]);
      expect(windowRepo.update).toHaveBeenCalledTimes(2);
    });

    it('returns empty array when no windows can sleep', async () => {
      const terminal = makeWindow({ id: 1, taskId: 5, windowType: 'terminal', workerType: null });
      const { service } = buildService({ windows: [terminal] });

      const result = await service.sleepTaskWindows(5);

      expect(result).toEqual([]);
    });
  });
});
