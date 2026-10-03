import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { TranscriptPaneService } from './TranscriptPaneService';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { MuxPaneInfo } from '@azito/shared';
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
  isolationIntent: false,
  isolationVerifiedAt: null,
  isolationReport: null, isolationCleanupReport: null,
  createdAt: '2026-01-01T00:00:00Z',
};

function buildDeps(overrides: {
  getSessionCwd?: TranscriptSource['getSessionCwd'];
  listAllPanes?: IMuxClient['listAllPanes'];
  probePane?: IMuxClient['probePane'];
  sendKeysToHandle?: IMuxClient['sendKeysToHandle'];
  sendTextToHandle?: IMuxClient['sendTextToHandle'];
  servers?: ServerConfig[];
} = {}) {
  const claudeTranscriptSource = {
    getSessionCwd: overrides.getSessionCwd ?? (() => ({ cwd: null })),
  } as unknown as TranscriptSource;

  const driver = {
    listAllPanes: overrides.listAllPanes ?? (async () => []),
    probePane: overrides.probePane ?? (async () => ({ alive: true, verified: true })),
    sendKeysToHandle: overrides.sendKeysToHandle ?? (async () => {}),
    sendTextToHandle: overrides.sendTextToHandle ?? (async () => {}),
  } as unknown as IMuxClient;

  const muxDriverRegistry = {
    resolve: () => driver,
  } as unknown as MuxDriverRegistry;

  const serverRepo = {
    findAll: () => overrides.servers ?? [LOCAL_SERVER],
  } as unknown as IServerRepository;

  return { claudeTranscriptSource, muxDriverRegistry, serverRepo };
}

describe('TranscriptPaneService', () => {
  describe('listPaneCandidates', () => {
    it('returns null when the session is not found', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      expect(await service.listPaneCandidates(SID)).toBeNull();
    });

    it('marks panes whose currentPath matches the session cwd as cwdMatch: true', async () => {
      const panes: MuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w1', paneIndex: 0, currentPath: '/home/user/proj', currentCommand: 'claude' },
        { paneId: '%2', sessionName: 'main', windowIndex: 1, windowName: 'w2', paneIndex: 0, currentPath: '/home/user/other', currentCommand: 'bash' },
      ];
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/home/user/proj' }),
        listAllPanes: async () => panes,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      const result = await service.listPaneCandidates(SID);
      expect(result).not.toBeNull();
      expect(result!.cwd).toBe('/home/user/proj');
      expect(result!.panes.find((p) => p.paneId === '%1')!.cwdMatch).toBe(true);
      expect(result!.panes.find((p) => p.paneId === '%2')!.cwdMatch).toBe(false);
    });

    it('marks all panes cwdMatch: false when the session has no recorded cwd', async () => {
      const panes: MuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w1', paneIndex: 0, currentPath: '/home/user/proj', currentCommand: 'claude' },
      ];
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: null }),
        listAllPanes: async () => panes,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      const result = await service.listPaneCandidates(SID);
      expect(result!.panes[0].cwdMatch).toBe(false);
    });

    describe('with several local servers', () => {
      const MISAO_LOCAL: ServerConfig = { ...LOCAL_SERVER, name: 'misao-local', muxRuntime: 'misao' };
      const TMUX_LOCAL2: ServerConfig = { ...LOCAL_SERVER, name: 'local2' };
      const MISAO_PANE = 'p_01HZX3K9M2N4P5Q6R7S8T9V0WX';

      function pane(paneId: string): MuxPaneInfo {
        return { paneId, sessionName: 's', windowIndex: 0, windowName: 'w', paneIndex: 0, currentPath: '/x', currentCommand: 'claude' } as MuxPaneInfo;
      }

      function build(servers: ServerConfig[]) {
        const deps = buildDeps({ getSessionCwd: () => ({ cwd: '/x' }), servers });
        const sent: Array<{ server: string; handle: string }> = [];
        const registry = {
          resolve: (s: ServerConfig) => ({
            listAllPanes: async () => [pane(s.muxRuntime === 'misao' ? MISAO_PANE : `%${s.name.length}`)],
            probePane: async () => ({ alive: true, verified: true }),
            sendTextToHandle: async (_s: ServerConfig, handle: string) => { sent.push({ server: s.name, handle }); },
            sendKeysToHandle: async () => {},
          }),
        } as unknown as MuxDriverRegistry;
        return { service: new TranscriptPaneService(deps.claudeTranscriptSource, registry, deps.serverRepo), sent };
      }

      it('lists panes from one local server per mux kind', async () => {
        const { service } = build([LOCAL_SERVER, TMUX_LOCAL2, MISAO_LOCAL]);
        const result = await service.listPaneCandidates(SID);
        expect(result!.panes.map((p) => p.paneId)).toEqual(['%5', MISAO_PANE]);
      });

      it('routes input to the local server whose mux kind matches the handle', async () => {
        const { service, sent } = build([LOCAL_SERVER, MISAO_LOCAL]);
        expect(await service.sendInput(SID, asPaneHandle(MISAO_PANE), 'hi')).toBe('ok');
        expect(await service.sendInput(SID, asPaneHandle('%1'), 'hi')).toBe('ok');
        expect(sent).toEqual([
          { server: 'misao-local', handle: MISAO_PANE },
          { server: 'local', handle: '%1' },
        ]);
      });

      it('returns pane_not_found when no local server matches the handle kind', async () => {
        const { service } = build([LOCAL_SERVER, TMUX_LOCAL2]);
        expect(await service.sendInput(SID, asPaneHandle(MISAO_PANE), 'hi')).toBe('pane_not_found');
      });
    });

    it('throws when no local server is configured', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        servers: [],
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      await expect(service.listPaneCandidates(SID)).rejects.toThrow();
    });
  });

  describe('sendInput', () => {
    it('returns session_not_found when the session does not exist', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      expect(await service.sendInput(SID, asPaneHandle('%1'), 'hello')).toBe('session_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        probePane: async () => ({ alive: false, verified: true }),
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      expect(await service.sendInput(SID, asPaneHandle('%1'), 'hello')).toBe('pane_not_found');
    });

    it('sends the text as literal, then Enter as a separate keypress, and returns ok', async () => {
      const sendKeysToHandle = vi.fn(async () => {});
      const sendTextToHandle = vi.fn(async () => {});
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        probePane: async () => ({ alive: true, verified: true }),
        sendKeysToHandle,
        sendTextToHandle,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(SID, asPaneHandle('%1'), 'hello world');
      expect(result).toBe('ok');
      expect(sendTextToHandle).toHaveBeenCalledWith(LOCAL_SERVER, '%1', 'hello world');
      expect(sendKeysToHandle).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['Enter']);
    });

    it('sends body text like "C-c" via the literal path, never as a special key', async () => {
      const sendKeysToHandle = vi.fn(async () => {});
      const sendTextToHandle = vi.fn(async () => {});
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        probePane: async () => ({ alive: true, verified: true }),
        sendKeysToHandle,
        sendTextToHandle,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      const result = await service.sendInput(SID, asPaneHandle('%1'), 'C-c');
      expect(result).toBe('ok');
      expect(sendTextToHandle).toHaveBeenCalledWith(LOCAL_SERVER, '%1', 'C-c');
      expect(sendKeysToHandle).toHaveBeenCalledTimes(1);
      expect(sendKeysToHandle).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['Enter']);
      expect(sendKeysToHandle).not.toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['C-c', 'Enter']);
    });
  });

  describe('sendSignal', () => {
    it('returns session_not_found when the given source has no such session', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({ getSessionCwd: () => null });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      expect(await service.sendSignal(claudeTranscriptSource, SID, asPaneHandle('%1'), 'Escape')).toBe('session_not_found');
    });

    it('returns pane_not_found when the pane no longer exists', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        probePane: async () => ({ alive: false, verified: true }),
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      expect(await service.sendSignal(claudeTranscriptSource, SID, asPaneHandle('%1'), 'Escape')).toBe('pane_not_found');
    });

    it('sends the given key via sendKeysToHandle (special-key path, not literal text) and returns ok', async () => {
      const sendKeysToHandle = vi.fn(async () => {});
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => ({ cwd: '/x' }),
        probePane: async () => ({ alive: true, verified: true }),
        sendKeysToHandle,
      });
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      const result = await service.sendSignal(claudeTranscriptSource, SID, asPaneHandle('%1'), 'C-c');
      expect(result).toBe('ok');
      expect(sendKeysToHandle).toHaveBeenCalledWith(LOCAL_SERVER, '%1', ['C-c']);
    });

    it('resolves the session via the passed-in source, not the constructor-injected one', async () => {
      const { claudeTranscriptSource, muxDriverRegistry, serverRepo } = buildDeps({
        getSessionCwd: () => null,
        probePane: async () => ({ alive: true, verified: true }),
      });
      const otherSource = { getSessionCwd: () => ({ cwd: null }) } as unknown as TranscriptSource;
      const service = new TranscriptPaneService(claudeTranscriptSource, muxDriverRegistry, serverRepo);
      expect(await service.sendSignal(otherSource, SID, asPaneHandle('%1'), 'Escape')).toBe('ok');
    });
  });
});
