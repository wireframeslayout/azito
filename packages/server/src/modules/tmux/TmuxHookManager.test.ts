import { describe, it, expect, vi } from 'vitest';
import { TmuxHookManager } from './TmuxHookManager';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';

function makeMockTransportFactory() {
  const execTmux = vi.fn().mockResolvedValue('');
  const factory = {
    getTransport: () => ({ execTmux }),
  } as unknown as TransportFactory;
  return { factory, execTmux };
}

const server: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;

describe('TmuxHookManager', () => {
  it('includes Authorization Bearer header in hook commands', async () => {
    const { factory, execTmux } = makeMockTransportFactory();
    const manager = new TmuxHookManager(factory, 3001, 'my-secret-token');

    await manager.install(server);

    expect(execTmux).toHaveBeenCalled();
    for (const call of execTmux.mock.calls) {
      const hookValue = call[0][3] as string;
      expect(hookValue).toContain("Authorization: Bearer my-secret-token");
      expect(hookValue).toContain("-H");
    }
  });

  it('sets hooks for all 7 tmux events', async () => {
    const { factory, execTmux } = makeMockTransportFactory();
    const manager = new TmuxHookManager(factory, 3001, 'token');

    await manager.install(server);

    expect(execTmux).toHaveBeenCalledTimes(7);
    const events = execTmux.mock.calls.map((c: unknown[]) => {
      const hookName = (c[0] as string[])[2] as string;
      return hookName.replace(/\[\d+\]$/, '');
    });
    expect(events).toContain('window-linked');
    expect(events).toContain('window-unlinked');
    expect(events).toContain('after-rename-window');
    expect(events).toContain('after-kill-pane');
    expect(events).toContain('session-window-changed');
    expect(events).toContain('session-closed');
    expect(events).toContain('after-select-pane');
  });
});
