import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentActivityMonitor } from './AgentActivityMonitor';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import type { IWindowRepository, Window } from '../windows/Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { IMuxClient } from '../tmux/IMuxClient';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';

const MISAO_WINDOW = 'w_01J8ZK3M5N7P9Q2R4S6T8V0WXY';

function makeWindow(overrides: Partial<Window>): Window {
  return {
    id: 1, ownerType: 'project', projectId: 1, taskId: null, serverName: 'local', tmuxTarget: 'azito:agent-1',
    label: 'agent-1', isPrimary: false, windowType: 'agent', workerType: 'claude', workerModel: null,
    agentSessionId: null, launchCommand: null, workingDirectory: null, paneLayout: null, sleeping: false,
    createdAt: '2026-01-01T00:00:00Z', ...overrides,
  };
}

function server(name: string, defaultMux: ServerConfig['defaultMux']): ServerConfig {
  return { name, type: 'local', defaultMux, muxRuntime: 'system' } as ServerConfig;
}

describe('AgentActivityMonitor with a misao server whose driver is unavailable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps tracking the tmux server, never throws, and warns once about the misao server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listWorkspaces = vi.fn().mockResolvedValue([]);
    const registry = new MuxDriverRegistry();
    registry.register('tmux', { kind: 'tmux', listWorkspaces, captureScreen: vi.fn() } as unknown as IMuxClient);

    const servers: Record<string, ServerConfig> = { local: server('local', 'tmux'), misao1: server('misao1', 'misao') };
    const emit = vi.fn();
    const monitor = new AgentActivityMonitor(
      { getRunning: () => ({ 5: [{ taskId: 10, target: 'azito:task-10', serverName: 'local' }] }) } as unknown as ExecuteTaskUseCase,
      {
        findAll: () => [
          makeWindow({ id: 2, serverName: 'misao1', tmuxTarget: MISAO_WINDOW, muxRef: { kind: 'misao', workspace: 'ws', window: MISAO_WINDOW } }),
          makeWindow({ id: 3, serverName: 'local', tmuxTarget: 'azito:agent-2' }),
        ],
      } as unknown as IWindowRepository,
      registry,
      { findByName: (name: string) => servers[name] ?? null } as unknown as IServerRepository,
      { emit } as unknown as NotificationBus,
    );

    await monitor.tick();
    await monitor.tick();

    expect(error).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ serverName: 'local', target: 'azito:task-10', running: true, source: 'operation' }),
    }));
    expect(listWorkspaces).toHaveBeenCalledWith(servers.local);
    expect(listWorkspaces).not.toHaveBeenCalledWith(servers.misao1);
    const misaoWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('misao1'));
    expect(misaoWarnings).toHaveLength(1);
    expect(String(misaoWarnings[0][0])).toContain('driver_not_registered');
  });
});
