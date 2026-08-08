import { describe, it, expect, vi } from 'vitest';
import { TranscriptPaneService } from './TranscriptPaneService';
import type { TranscriptService } from './TranscriptService';
import type { TmuxClient, TmuxPaneInfo } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';

const SID = '11111111-1111-1111-1111-111111111111';
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

function buildDeps(overrides: {
  getSessionCwd?: TranscriptService['getSessionCwd'];
  listAllPanes?: TmuxClient['listAllPanes'];
  checkPaneExists?: TmuxClient['checkPaneExists'];
  sendKeys?: TmuxClient['sendKeys'];
  servers?: ServerConfig[];
} = {}) {
  const transcriptService = {
    getSessionCwd: overrides.getSessionCwd ?? (() => ({ cwd: null })),
  } as unknown as TranscriptService;

  const tmuxClient = {
    listAllPanes: overrides.listAllPanes ?? (async () => []),
    checkPaneExists: overrides.checkPaneExists ?? (async () => true),
    sendKeys: overrides.sendKeys ?? (async () => {}),
  } as unknown as TmuxClient;

  const serverRepo = {
    findAll: () => overrides.servers ?? [LOCAL_SERVER],
  } as unknown as IServerRepository;

  return { transcriptService, tmuxClient, serverRepo };
}

describe('TranscriptPaneService', () => {
  describe('listPaneCandidates', () => {
    it('returns null when the session is not found', async () => {
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      expect(await service.listPaneCandidates(SID)).toBeNull();
    });

    it('marks panes whose currentPath matches the session cwd as cwdMatch: true', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowName: 'w1', currentPath: '/home/user/proj', currentCommand: 'claude' },
        { paneId: '%2', sessionName: 'main', windowName: 'w2', currentPath: '/home/user/other', currentCommand: 'bash' },
      ];
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/home/user/proj' }),
        listAllPanes: async () => panes,
      });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      const result = await service.listPaneCandidates(SID);
      expect(result).not.toBeNull();
      expect(result!.cwd).toBe('/home/user/proj');
      expect(result!.panes.find((p) => p.paneId === '%1')!.cwdMatch).toBe(true);
      expect(result!.panes.find((p) => p.paneId === '%2')!.cwdMatch).toBe(false);
    });

    it('marks all panes cwdMatch: false when the session has no recorded cwd', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowName: 'w1', currentPath: '/home/user/proj', currentCommand: 'claude' },
      ];
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: null }),
        listAllPanes: async () => panes,
      });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      const result = await service.listPaneCandidates(SID);
      expect(result!.panes[0].cwdMatch).toBe(false);
    });

    it('throws when no local server is configured', async () => {
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        servers: [],
      });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      await expect(service.listPaneCandidates(SID)).rejects.toThrow();
    });
  });

  describe('sendInput', () => {
    it('returns session_not_found when the session does not exist', async () => {
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      expect(await service.sendInput(SID, '%1', 'hello')).toBe('session_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => false,
      });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      expect(await service.sendInput(SID, '%1', 'hello')).toBe('pane_not_found');
    });

    it('sends the text followed by Enter and returns ok', async () => {
      const sendKeys = vi.fn(async () => {});
      const { transcriptService, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => true,
        sendKeys,
      });
      const service = new TranscriptPaneService(transcriptService, tmuxClient, serverRepo);
      const result = await service.sendInput(SID, '%1', 'hello world');
      expect(result).toBe('ok');
      expect(sendKeys).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['hello world', 'Enter']);
    });
  });
});
