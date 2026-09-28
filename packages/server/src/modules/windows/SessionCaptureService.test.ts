import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionCaptureService } from './SessionCaptureService';
import type { IWindowRepository, Window } from './Window';
import type { ITaskRepository } from '../tasks/Task';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { ISessionStrategyFactory, ISessionStrategy } from '../agents/SessionStrategy';

function makeWindow(overrides?: Partial<Window>): Window {
  return {
    id: 1,
    ownerType: 'project',
    projectId: 1,
    taskId: null,
    serverName: 'local',
    tmuxTarget: 'sess:win.1',
    label: null,
    isPrimary: false,
    windowType: 'agent',
    workerType: 'codex',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: '/home/user/project',
    paneLayout: null,
    sleeping: false,
    createdAt: '2026-01-01T00:00:00',
    ...overrides,
  };
}

function makeServer(): ServerConfig {
  return { name: 'local', type: 'local', host: 'localhost' } as ServerConfig;
}

describe('SessionCaptureService', () => {
  let windowRepo: {
    findById: ReturnType<typeof vi.fn>;
    findAgentSessionIdsByServer: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateAgentSessionIdByWindow: ReturnType<typeof vi.fn>;
  };
  let taskRepo: { findAgentSessionIdsByServer: ReturnType<typeof vi.fn> };
  let serverRepo: { findByName: ReturnType<typeof vi.fn> };
  let scanSessionId: ReturnType<typeof vi.fn>;
  let excludeSessionId: ReturnType<typeof vi.fn>;
  let strategyFactory: ISessionStrategyFactory;
  let service: SessionCaptureService;

  beforeEach(() => {
    windowRepo = {
      findById: vi.fn(),
      findAgentSessionIdsByServer: vi.fn().mockReturnValue(new Set()),
      update: vi.fn(),
      updateAgentSessionIdByWindow: vi.fn(),
    };
    taskRepo = {
      findAgentSessionIdsByServer: vi.fn().mockReturnValue(new Set()),
    };
    serverRepo = {
      findByName: vi.fn().mockReturnValue(makeServer()),
    };
    scanSessionId = vi.fn();
    excludeSessionId = vi.fn();
    strategyFactory = {
      create: () => ({
        supportsSession: true,
        needsPostLaunchScan: true,
        buildNewSessionFlags: () => '',
        buildResumeFlags: () => '',
        buildRespawnCommand: () => null,
        scanSessionId: scanSessionId as ISessionStrategy['scanSessionId'],
        excludeSessionId: excludeSessionId as ISessionStrategy['excludeSessionId'],
      }),
    };
    service = new SessionCaptureService(
      windowRepo as unknown as IWindowRepository,
      taskRepo as unknown as ITaskRepository,
      serverRepo as unknown as IServerRepository,
      strategyFactory,
    );
  });

  describe('tryScanForWindow', () => {
    it('captures session ID when scan returns a result', async () => {
      const win = makeWindow();
      windowRepo.findById.mockReturnValue(win);
      scanSessionId.mockResolvedValue('abc-123');

      const result = await service.tryScanForWindow(win.id);

      expect(result).toBe('abc-123');
      expect(windowRepo.updateAgentSessionIdByWindow).toHaveBeenCalledWith(win.serverName, win.tmuxTarget, 'abc-123');
    });

    it('skips scan when agentSessionId is already set', async () => {
      const win = makeWindow({ agentSessionId: 'existing-id' });
      windowRepo.findById.mockReturnValue(win);

      const result = await service.tryScanForWindow(win.id);

      expect(result).toBeNull();
      expect(scanSessionId).not.toHaveBeenCalled();
    });

    it('skips scan for claude workers (needsPostLaunchScan=false)', async () => {
      const win = makeWindow({ workerType: 'claude' });
      windowRepo.findById.mockReturnValue(win);
      strategyFactory = {
        create: () => ({
          supportsSession: true,
          needsPostLaunchScan: false,
          buildNewSessionFlags: () => '',
          buildResumeFlags: () => '',
          buildRespawnCommand: () => null,
          scanSessionId: scanSessionId as ISessionStrategy['scanSessionId'],
        }),
      };
      service = new SessionCaptureService(
        windowRepo as unknown as IWindowRepository,
        taskRepo as unknown as ITaskRepository,
        serverRepo as unknown as IServerRepository,
        strategyFactory,
      );

      const result = await service.tryScanForWindow(win.id);

      expect(result).toBeNull();
      expect(scanSessionId).not.toHaveBeenCalled();
    });

    it('excludes already-assigned session IDs', async () => {
      const win = makeWindow();
      windowRepo.findById.mockReturnValue(win);
      scanSessionId.mockResolvedValue('already-assigned');
      windowRepo.findAgentSessionIdsByServer.mockReturnValue(new Set(['already-assigned']));

      const result = await service.tryScanForWindow(win.id);

      expect(result).toBeNull();
      expect(excludeSessionId).toHaveBeenCalledWith('already-assigned');
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });

    it('returns null when scan finds nothing', async () => {
      const win = makeWindow();
      windowRepo.findById.mockReturnValue(win);
      scanSessionId.mockResolvedValue(null);

      const result = await service.tryScanForWindow(win.id);

      expect(result).toBeNull();
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });

    it('returns null when window does not exist', async () => {
      windowRepo.findById.mockReturnValue(undefined);

      const result = await service.tryScanForWindow(999);

      expect(result).toBeNull();
      expect(scanSessionId).not.toHaveBeenCalled();
    });

    it('returns null when scan throws', async () => {
      const win = makeWindow();
      windowRepo.findById.mockReturnValue(win);
      scanSessionId.mockRejectedValue(new Error('transport error'));

      const result = await service.tryScanForWindow(win.id);

      expect(result).toBeNull();
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });

    it('passes afterTimestamp from window createdAt', async () => {
      const win = makeWindow({ createdAt: '2026-07-01T12:00:00' });
      windowRepo.findById.mockReturnValue(win);
      scanSessionId.mockResolvedValue(null);

      await service.tryScanForWindow(win.id);

      expect(scanSessionId).toHaveBeenCalledWith(
        expect.anything(),
        win.workingDirectory,
        new Date('2026-07-01T12:00:00Z'),
      );
    });
  });

  describe('adoptResolvedSession', () => {
    it('writes the session ID back onto the window when it has none yet and it is unassigned', () => {
      const win = makeWindow({ agentSessionId: null });
      windowRepo.findById.mockReturnValue(win);

      const result = service.adoptResolvedSession(win.id, 'resolved-session');

      expect(result).toBe(true);
      expect(windowRepo.updateAgentSessionIdByWindow).toHaveBeenCalledWith(win.serverName, win.tmuxTarget, 'resolved-session');
    });

    it('does not overwrite a window that already carries an agentSessionId', () => {
      const win = makeWindow({ agentSessionId: 'already-set' });
      windowRepo.findById.mockReturnValue(win);

      const result = service.adoptResolvedSession(win.id, 'resolved-session');

      expect(result).toBe(false);
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });

    it('does not write when the session is already assigned to another window on the server', () => {
      const win = makeWindow({ agentSessionId: null });
      windowRepo.findById.mockReturnValue(win);
      windowRepo.findAgentSessionIdsByServer.mockReturnValue(new Set(['resolved-session']));

      const result = service.adoptResolvedSession(win.id, 'resolved-session');

      expect(result).toBe(false);
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });

    it('does not write when the session is already assigned to a task on the server', () => {
      const win = makeWindow({ agentSessionId: null });
      windowRepo.findById.mockReturnValue(win);
      taskRepo.findAgentSessionIdsByServer.mockReturnValue(new Set(['resolved-session']));

      const result = service.adoptResolvedSession(win.id, 'resolved-session');

      expect(result).toBe(false);
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });

    it('returns false when the window does not exist', () => {
      windowRepo.findById.mockReturnValue(undefined);

      const result = service.adoptResolvedSession(999, 'resolved-session');

      expect(result).toBe(false);
      expect(windowRepo.updateAgentSessionIdByWindow).not.toHaveBeenCalled();
    });
  });
});
