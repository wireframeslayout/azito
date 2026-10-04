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

  // #311: a local misao-default server also hosts tmux, so its tmux side is still listed; only its misao windows are
  // unreadable, and that is warned about once.
  it('keeps tracking the tmux windows, never throws, and warns once about the misao side', async () => {
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
    expect(listWorkspaces).toHaveBeenCalledWith(servers.misao1);
    const misaoWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('misao1'));
    expect(misaoWarnings).toHaveLength(1);
    expect(String(misaoWarnings[0][0])).toContain('driver_not_registered');
  });
});

describe('AgentActivityMonitor on a tmux-default local server whose misao daemon stops (#311)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the misao window running and announces neither a deletion nor a completion while misao is down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const misaoRef = { kind: 'misao' as const, workspace: 'ws', window: MISAO_WINDOW };
    const misaoTarget = `ws:${MISAO_WINDOW}`;
    let daemonUp = true;
    const registry = new MuxDriverRegistry();
    registry.register('tmux', { kind: 'tmux', listWorkspaces: vi.fn(async () => []), captureScreen: vi.fn() } as unknown as IMuxClient);
    registry.register('misao', {
      kind: 'misao',
      listWorkspaces: vi.fn(async () => [{
        name: 'ws', windowCount: 1, attached: false, created: 0,
        windows: [{ index: 0, name: 'agent', active: true, activity: Math.floor(Date.now() / 1000), ref: misaoRef, panes: [{ index: 1, command: 'claude', title: '', active: true }] }],
      }]),
      captureScreen: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      resolvePane: vi.fn(async () => 'p_01J8ZK3M5N7P9Q2R4S6T8V0WXA'),
    } as unknown as IMuxClient, () => (daemonUp ? { available: true } : { available: false, reason: 'daemon_unreachable' }));

    const local = server('local', 'tmux');
    const emit = vi.fn();
    const monitor = new AgentActivityMonitor(
      { getRunning: () => ({}) } as unknown as ExecuteTaskUseCase,
      { findAll: () => [makeWindow({ id: 2, serverName: 'local', tmuxTarget: misaoTarget, muxRef: misaoRef, workerType: 'generic' })] } as unknown as IWindowRepository,
      registry,
      { findByName: (name: string) => (name === 'local' ? local : null) } as unknown as IServerRepository,
      { emit } as unknown as NotificationBus,
    );

    const drain = () => new Promise<void>((r) => setTimeout(r, 20));
    monitor.recordResolvedHookSignal('local', misaoTarget, 'start');
    await drain();
    expect(monitor.snapshot()).toEqual([expect.objectContaining({ target: misaoTarget, running: true })]);
    emit.mockClear();

    daemonUp = false;
    await monitor.tick();
    await monitor.tick();

    expect(monitor.snapshot()).toEqual([expect.objectContaining({ target: misaoTarget, running: true })]);
    const announced = emit.mock.calls.map(([event]) => event.payload);
    expect(announced.filter((p: { running?: boolean }) => p?.running === false)).toEqual([]);
    expect(announced.filter((p: { reason?: string }) => p?.reason === 'deleted')).toEqual([]);
  });
});
