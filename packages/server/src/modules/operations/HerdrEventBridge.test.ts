import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HerdrEventBridge } from './HerdrEventBridge';
import type { AgentActivityMonitor } from './AgentActivityMonitor';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { IServerRepository, ServerConfig } from '../servers/Server';

function makeBridge() {
  const recordMuxSignal = vi.fn();
  const monitor = { recordMuxSignal } as unknown as AgentActivityMonitor;
  const emitFn = vi.fn();
  const bus = { emit: emitFn } as unknown as NotificationBus;
  const servers: ServerConfig[] = [
    { name: 'herdr-local', type: 'local', muxRuntime: 'herdr' } as ServerConfig,
    { name: 'herdr-agent', type: 'agent', muxRuntime: 'herdr' } as ServerConfig,
  ];
  const serverRepo = {
    findAll: vi.fn(() => servers),
    findByName: vi.fn((name: string) => servers.find(s => s.name === name) ?? null),
  } as unknown as IServerRepository;

  const bridge = new HerdrEventBridge(monitor, bus, serverRepo);
  return { bridge, monitor, bus, serverRepo, recordMuxSignal, emitFn };
}

describe('HerdrEventBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleAgentMuxEvent (agent server relay)', () => {
    it('routes pane.agent_status_changed to recordMuxSignal with annotated labels', () => {
      const { bridge, recordMuxSignal } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        agent_status: 'working',
        workspace_label: 'default',
        tab_label: 'main',
      });

      expect(recordMuxSignal).toHaveBeenCalledWith('herdr-agent', 'default:main', 'working');
    });

    it('maps all valid agent statuses', () => {
      const { bridge, recordMuxSignal } = makeBridge();

      for (const status of ['working', 'idle', 'blocked', 'done', 'unknown']) {
        bridge.handleAgentMuxEvent('herdr-agent', {
          type: 'pane.agent_status_changed',
          pane_id: 'w1:p1',
          agent_status: status,
          workspace_label: 'ws',
        });
      }

      expect(recordMuxSignal).toHaveBeenCalledTimes(5);
      const targets = recordMuxSignal.mock.calls.map((c: unknown[]) => c[1] as string);
      expect(targets.every((t) => t === 'ws:main')).toBe(true);
      const statuses = recordMuxSignal.mock.calls.map((c: unknown[]) => c[2]);
      expect(statuses).toEqual(['working', 'idle', 'blocked', 'done', 'unknown']);
    });

    it('ignores events with invalid agent_status', () => {
      const { bridge, recordMuxSignal } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        agent_status: 'invalid_status',
        workspace_label: 'ws',
      });

      expect(recordMuxSignal).not.toHaveBeenCalled();
    });

    it('ignores events without pane_id', () => {
      const { bridge, recordMuxSignal } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', {
        type: 'pane.agent_status_changed',
        agent_status: 'working',
        workspace_label: 'ws',
      });

      expect(recordMuxSignal).not.toHaveBeenCalled();
    });

    it('ignores events without workspace_label (no target resolution)', () => {
      const { bridge, recordMuxSignal } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', {
        type: 'pane.agent_status_changed',
        pane_id: 'w1:p1',
        agent_status: 'working',
      });

      expect(recordMuxSignal).not.toHaveBeenCalled();
    });

    it('routes structural events to sessions:updated', () => {
      const { bridge, emitFn } = makeBridge();

      for (const type of ['tab.created', 'tab.closed', 'tab.renamed', 'workspace.created', 'workspace.closed', 'workspace.renamed']) {
        bridge.handleAgentMuxEvent('herdr-agent', { type });
      }

      expect(emitFn).toHaveBeenCalledTimes(6);
      for (const call of emitFn.mock.calls) {
        expect(call[0]).toEqual({
          type: 'sessions:updated',
          payload: { serverName: 'herdr-agent' },
        });
      }
    });

    it('routes pane.created and pane.closed to sessions:updated', () => {
      const { bridge, emitFn } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', { type: 'pane.created', pane_id: 'w1:p2' });
      bridge.handleAgentMuxEvent('herdr-agent', { type: 'pane.closed', pane_id: 'w1:p2' });

      expect(emitFn).toHaveBeenCalledTimes(2);
    });

    it('ignores non-object events', () => {
      const { bridge, recordMuxSignal, emitFn } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', null);
      bridge.handleAgentMuxEvent('herdr-agent', 'string');
      bridge.handleAgentMuxEvent('herdr-agent', 42);

      expect(recordMuxSignal).not.toHaveBeenCalled();
      expect(emitFn).not.toHaveBeenCalled();
    });

    it('ignores events without type', () => {
      const { bridge, recordMuxSignal, emitFn } = makeBridge();

      bridge.handleAgentMuxEvent('herdr-agent', { pane_id: 'w1:p1' });

      expect(recordMuxSignal).not.toHaveBeenCalled();
      expect(emitFn).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('remove is idempotent for unknown servers', () => {
      const { bridge } = makeBridge();
      bridge.remove('nonexistent');
    });

    it('add ignores non-herdr servers', () => {
      const { bridge, serverRepo } = makeBridge();
      (serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue({ name: 'tmux-server', type: 'local', muxRuntime: 'system' });
      bridge.add('tmux-server');
      bridge.stopAll();
    });
  });
});
