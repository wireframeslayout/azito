import { describe, it, expect, vi } from 'vitest';
import { TranscriptPaneService } from './TranscriptPaneService';
import type { TranscriptSource } from './sources/TranscriptSource';
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
  getSessionCwd?: TranscriptSource['getSessionCwd'];
  listAllPanes?: TmuxClient['listAllPanes'];
  checkPaneExists?: TmuxClient['checkPaneExists'];
  sendKeys?: TmuxClient['sendKeys'];
  sendLiteralText?: TmuxClient['sendLiteralText'];
  servers?: ServerConfig[];
} = {}) {
  const claudeTranscriptSource = {
    getSessionCwd: overrides.getSessionCwd ?? (() => ({ cwd: null })),
  } as unknown as TranscriptSource;

  const tmuxClient = {
    listAllPanes: overrides.listAllPanes ?? (async () => []),
    checkPaneExists: overrides.checkPaneExists ?? (async () => true),
    sendKeys: overrides.sendKeys ?? (async () => {}),
    sendLiteralText: overrides.sendLiteralText ?? (async () => {}),
  } as unknown as TmuxClient;

  const serverRepo = {
    findAll: () => overrides.servers ?? [LOCAL_SERVER],
  } as unknown as IServerRepository;

  return { claudeTranscriptSource, tmuxClient, serverRepo };
}

describe('TranscriptPaneService', () => {
  describe('listPaneCandidates', () => {
    it('returns null when the session is not found', async () => {
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      expect(await service.listPaneCandidates(SID)).toBeNull();
    });

    it('marks panes whose currentPath matches the session cwd as cwdMatch: true', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w1', paneIndex: 0, currentPath: '/home/user/proj', currentCommand: 'claude' },
        { paneId: '%2', sessionName: 'main', windowIndex: 1, windowName: 'w2', paneIndex: 0, currentPath: '/home/user/other', currentCommand: 'bash' },
      ];
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/home/user/proj' }),
        listAllPanes: async () => panes,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      const result = await service.listPaneCandidates(SID);
      expect(result).not.toBeNull();
      expect(result!.cwd).toBe('/home/user/proj');
      expect(result!.panes.find((p) => p.paneId === '%1')!.cwdMatch).toBe(true);
      expect(result!.panes.find((p) => p.paneId === '%2')!.cwdMatch).toBe(false);
    });

    it('marks all panes cwdMatch: false when the session has no recorded cwd', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w1', paneIndex: 0, currentPath: '/home/user/proj', currentCommand: 'claude' },
      ];
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: null }),
        listAllPanes: async () => panes,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      const result = await service.listPaneCandidates(SID);
      expect(result!.panes[0].cwdMatch).toBe(false);
    });

    it('throws when no local server is configured', async () => {
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        servers: [],
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      await expect(service.listPaneCandidates(SID)).rejects.toThrow();
    });
  });

  describe('sendInput', () => {
    it('returns session_not_found when the session does not exist', async () => {
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      expect(await service.sendInput(SID, '%1', 'hello')).toBe('session_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => false,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      expect(await service.sendInput(SID, '%1', 'hello')).toBe('pane_not_found');
    });

    it('sends the text as literal, then Enter as a separate keypress, and returns ok', async () => {
      const sendKeys = vi.fn(async () => {});
      const sendLiteralText = vi.fn(async () => {});
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => true,
        sendKeys,
        sendLiteralText,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      const result = await service.sendInput(SID, '%1', 'hello world');
      expect(result).toBe('ok');
      expect(sendLiteralText).toHaveBeenCalledWith(LOCAL_SERVER, '%1', 'hello world');
      expect(sendKeys).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['Enter']);
    });

    it('sends body text like "C-c" via the literal path, never as a special key', async () => {
      const sendKeys = vi.fn(async () => {});
      const sendLiteralText = vi.fn(async () => {});
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => true,
        sendKeys,
        sendLiteralText,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      const result = await service.sendInput(SID, '%1', 'C-c');
      expect(result).toBe('ok');
      // The literal text "C-c" must go through sendLiteralText (always -l), never through
      // sendKeys with "C-c" as an element — sendKeys would interpret that as an interrupt key.
      expect(sendLiteralText).toHaveBeenCalledWith(LOCAL_SERVER, '%1', 'C-c');
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['Enter']);
      expect(sendKeys).not.toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['C-c', 'Enter']);
    });
  });

  describe('sendSignal', () => {
    it('returns session_not_found when the given source has no such session', async () => {
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      expect(await service.sendSignal(claudeTranscriptSource, SID, '%1', 'Escape')).toBe('session_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => false,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      expect(await service.sendSignal(claudeTranscriptSource, SID, '%1', 'Escape')).toBe('pane_not_found');
    });

    it('sends the given key via sendKeys (special-key path, not literal text) and returns ok', async () => {
      const sendKeys = vi.fn(async () => {});
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        checkPaneExists: async () => true,
        sendKeys,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      const result = await service.sendSignal(claudeTranscriptSource, SID, '%1', 'C-c');
      expect(result).toBe('ok');
      expect(sendKeys).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['C-c']);
    });

    it('resolves the session via the passed-in source, not the constructor-injected one', async () => {
      // The constructor-injected source (claude) has no matching session, but the source passed
      // explicitly into sendSignal (a stand-in for a codex source) does — this is what lets
      // sendSignal support agent types other than claude despite the service being constructed
      // with a single claude-bound source.
      const { claudeTranscriptSource, tmuxClient, serverRepo } = buildDeps({
        getSessionCwd: () => null,
        checkPaneExists: async () => true,
      });
      const otherSource = { getSessionCwd: () => ({ cwd: null }) } as unknown as TranscriptSource;
      const service = new TranscriptPaneService(claudeTranscriptSource, tmuxClient, serverRepo);
      expect(await service.sendSignal(otherSource, SID, '%1', 'Escape')).toBe('ok');
    });
  });
});
