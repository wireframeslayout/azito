import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { WorkerInputService } from './WorkerInputService';
import { SupervisorCommandError } from '../../supervisors/SupervisorRegistry';
import type { ServerConfig } from '../../servers/Server';

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
  muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as ServerConfig;
}

function makeHarness(sendCommandImpl?: () => Promise<void>) {
  const mockDriver = {
    sendKeysToHandle: vi.fn(async () => {}),
    // Default: a live worker in the foreground, so the dead-worker shell
    // guard on the supervised sendPrompt fallback path stays out of the way.
    paneCommandByHandle: vi.fn(async (): Promise<string | null> => 'claude'),
  };
  const muxDriverRegistry = {
    resolve: vi.fn(() => mockDriver),
  };
  const registry = {
    isConnected: vi.fn(() => true),
    isBoundConnected: vi.fn(() => true),
    sendCommand: vi.fn(sendCommandImpl ?? (async () => {})),
  };
  const appendLog = vi.fn();
  const service = new WorkerInputService(muxDriverRegistry as any, registry as any, appendLog);
  return { service, mockDriver, muxDriverRegistry, registry, appendLog };
}

const server = makeServer();
const target = asPaneHandle('azito:1.1');

// Issue #28 third-party review, Important finding (fix 2): task input
// (prompt injection / key sends) must gate on isBoundConnected, not
// isConnected — an unbound (unverified) connection must never receive it.
describe('WorkerInputService — bound gate (Issue #28 third-party review, Important)', () => {
  it('sendPrompt falls back to tmux.sendKeysToHandle when the connection is live but unbound, without calling sendCommand', async () => {
    const { service, mockDriver, registry, appendLog } = makeHarness();
    registry.isConnected.mockReturnValue(true);
    registry.isBoundConnected.mockReturnValue(false);

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).not.toHaveBeenCalled();
    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('sendKeys falls back to tmux.sendKeysToHandle when the connection is live but unbound, without calling sendCommand', async () => {
    const { service, mockDriver, registry } = makeHarness();
    registry.isConnected.mockReturnValue(true);
    registry.isBoundConnected.mockReturnValue(false);

    await service.sendKeys(server, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).not.toHaveBeenCalled();
    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['y', 'Enter']);
  });

  it('sendPrompt routes to registry.sendCommand when bound', async () => {
    const { service, mockDriver, registry } = makeHarness();
    registry.isConnected.mockReturnValue(true);
    registry.isBoundConnected.mockReturnValue(true);

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).toHaveBeenCalledWith('local-server', target, {
      type: 'inject_prompt',
      text: 'hello worker',
      submit: true,
    });
    expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
  });
});

describe('WorkerInputService.sendPrompt', () => {
  it('routes to registry.sendCommand (inject_prompt) when supervisor is connected', async () => {
    const { service, mockDriver, registry, appendLog } = makeHarness();

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).toHaveBeenCalledWith('local-server', target, {
      type: 'inject_prompt',
      text: 'hello worker',
      submit: true,
    });
    expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('falls back to tmux.sendKeysToHandle (with a fallback log) when supervisor is not connected', async () => {
    const { service, mockDriver, registry, appendLog } = makeHarness();
    registry.isBoundConnected.mockReturnValue(false);

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).not.toHaveBeenCalled();
    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('falls back to tmux.sendKeysToHandle (with a fallback log) when sendCommand rejects with reason "not_sent" (never left the hub)', async () => {
    const { service, mockDriver, appendLog } = makeHarness(async () => {
      throw new SupervisorCommandError('supervisor not connected: local-server::azito:1.1', 'not_sent');
    });

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({
      type: 'supervisor_inject_fallback',
      reason: 'supervisor not connected: local-server::azito:1.1',
    }));
  });

  it('does NOT fall back to tmux (avoids double-injection) when sendCommand rejects with reason "ack_timeout" — logs an ambiguous-timeout marker instead', async () => {
    const { service, mockDriver, appendLog } = makeHarness(async () => {
      throw new SupervisorCommandError('ack timeout: local-server::azito:1.1', 'ack_timeout');
    });

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({
      type: 'supervisor_inject_ambiguous_timeout',
      reason: 'ack timeout: local-server::azito:1.1',
    }));
  });

  it('falls back when sendCommand rejects with a plain (non-SupervisorCommandError) error, same as "not_sent"', async () => {
    const { service, mockDriver, appendLog } = makeHarness(async () => { throw new Error('socket write failed'); });

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({
      type: 'supervisor_inject_fallback',
      reason: 'socket write failed',
    }));
  });

  it('goes straight to tmux.sendKeysToHandle when supervisor is not connected', async () => {
    const { service, mockDriver, registry, appendLog } = makeHarness();
    registry.isBoundConnected.mockReturnValue(false);

    await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).not.toHaveBeenCalled();
    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('omits the fallback log when no ctx is supplied', async () => {
    const { service, appendLog, registry } = makeHarness();
    registry.isBoundConnected.mockReturnValue(false);

    await service.sendPrompt(server, target, 'hello worker');

    expect(appendLog).not.toHaveBeenCalled();
  });

  describe('dead-worker shell guard on the supervisor fallback path (E2E task 5 incident)', () => {
    it('aborts the tmux fallback injection (with an aborted log) when the pane foreground is a bare shell', async () => {
      const { service, mockDriver, appendLog } = makeHarness(async () => {
        throw new SupervisorCommandError('supervisor not connected: local-server::azito:1.1', 'not_sent');
      });
      mockDriver.paneCommandByHandle.mockResolvedValue('bash');

      await service.sendPrompt(server, target, 'line1\nazitoctl complete --turn 99', { taskId: 1, unitId: 2 });

      expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
      expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({
        type: 'supervisor_inject_aborted_dead_worker',
        foreground: 'bash',
      }));
    });

    it('proceeds with the tmux fallback injection when the pane foreground is a live worker (claude)', async () => {
      const { service, mockDriver } = makeHarness(async () => {
        throw new SupervisorCommandError('supervisor not connected: local-server::azito:1.1', 'not_sent');
      });
      mockDriver.paneCommandByHandle.mockResolvedValue('claude');

      await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

      expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    });

    it('proceeds with the injection when the foreground command cannot be determined (null) — a tmux error must not silently kill a healthy task', async () => {
      const { service, mockDriver, appendLog } = makeHarness(async () => {
        throw new SupervisorCommandError('supervisor not connected: local-server::azito:1.1', 'not_sent');
      });
      mockDriver.paneCommandByHandle.mockResolvedValue(null);

      await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

      expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
      expect(appendLog).not.toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({
        type: 'supervisor_inject_aborted_dead_worker',
      }));
    });

    it('also guards the sendCommand-rejection (not_sent) fallback branch, not only the not-connected branch', async () => {
      const { service, mockDriver, appendLog } = makeHarness(async () => {
        throw new SupervisorCommandError('failed to send command: local-server::azito:1.1', 'not_sent');
      });
      mockDriver.paneCommandByHandle.mockResolvedValue('zsh');

      await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

      expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
      expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({
        type: 'supervisor_inject_aborted_dead_worker',
        foreground: 'zsh',
      }));
    });

    it('when supervisor is not connected, goes straight to tmux without checking foreground command', async () => {
      const { service, mockDriver, registry } = makeHarness();
      registry.isBoundConnected.mockReturnValue(false);
      mockDriver.paneCommandByHandle.mockResolvedValue('bash');

      await service.sendPrompt(server, target, 'hello worker', { taskId: 1, unitId: 2 });

      expect(mockDriver.paneCommandByHandle).not.toHaveBeenCalled();
      expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['hello worker', 'Enter']);
    });

    it('does not run the guard on sendKeys (y/Enter is harmless in a shell) — autoConfirm keeps its exact previous behavior', async () => {
      const { service, mockDriver, registry } = makeHarness();
      registry.isBoundConnected.mockReturnValue(false);
      mockDriver.paneCommandByHandle.mockResolvedValue('bash');

      await service.sendKeys(server, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

      expect(mockDriver.paneCommandByHandle).not.toHaveBeenCalled();
      expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['y', 'Enter']);
    });
  });
});

describe('WorkerInputService.sendKeys', () => {
  it('routes to registry.sendCommand (send_keys) when supervisor is connected', async () => {
    const { service, mockDriver, registry } = makeHarness();

    await service.sendKeys(server, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).toHaveBeenCalledWith('local-server', target, { type: 'send_keys', keys: ['y', 'Enter'] });
    expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
  });

  it('falls back to tmux.sendKeysToHandle when not connected, matching the pre-existing autoConfirm call shape', async () => {
    const { service, mockDriver, registry } = makeHarness();
    registry.isBoundConnected.mockReturnValue(false);

    await service.sendKeys(server, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['y', 'Enter']);
  });

  it('falls back to tmux.sendKeysToHandle when sendCommand rejects with reason "not_sent"', async () => {
    const { service, mockDriver, appendLog } = makeHarness(async () => {
      throw new SupervisorCommandError('failed to send command: local-server::azito:1.1', 'not_sent');
    });

    await service.sendKeys(server, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(server, target, ['y', 'Enter']);
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({ type: 'supervisor_inject_fallback' }));
  });

  it('does NOT fall back to tmux when sendCommand rejects with reason "ack_timeout"', async () => {
    const { service, mockDriver, appendLog } = makeHarness(async () => {
      throw new SupervisorCommandError('ack timeout: local-server::azito:1.1', 'ack_timeout');
    });

    await service.sendKeys(server, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

    expect(mockDriver.sendKeysToHandle).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', expect.objectContaining({ type: 'supervisor_inject_ambiguous_timeout' }));
  });

  it('goes straight to tmux.sendKeysToHandle when supervisor is not connected (regardless of server type)', async () => {
    const { service, mockDriver, registry, appendLog } = makeHarness();
    registry.isBoundConnected.mockReturnValue(false);
    const agentServer = makeServer({ name: 'agent-server', type: 'agent' });

    await service.sendKeys(agentServer, target, ['y', 'Enter'], { taskId: 1, unitId: 2 });

    expect(registry.sendCommand).not.toHaveBeenCalled();
    expect(mockDriver.sendKeysToHandle).toHaveBeenCalledWith(agentServer, target, ['y', 'Enter']);
    expect(appendLog).not.toHaveBeenCalled();
  });
});
