import { describe, it, expect, vi } from 'vitest';
import { TmuxHookManager, syncTmuxChangeHooks } from './TmuxHookManager';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';

function makeMockTransportFactory() {
  const execMux = vi.fn().mockResolvedValue('');
  const factory = {
    getTransport: () => ({ execMux }),
  } as unknown as TransportFactory;
  return { factory, execMux };
}

const server: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;

describe('TmuxHookManager', () => {
  it('includes Authorization Bearer header in hook commands', async () => {
    const { factory, execMux } = makeMockTransportFactory();
    const manager = new TmuxHookManager(factory, 3001, 'my-secret-token');

    await manager.install(server);

    expect(execMux).toHaveBeenCalled();
    for (const call of execMux.mock.calls) {
      const hookValue = (call[0] as { args: string[] }).args[3] as string;
      expect(hookValue).toContain("Authorization: Bearer my-secret-token");
      expect(hookValue).toContain("-H");
    }
  });

  it('sets hooks for all 7 tmux events', async () => {
    const { factory, execMux } = makeMockTransportFactory();
    const manager = new TmuxHookManager(factory, 3001, 'token');

    await manager.install(server);

    expect(execMux).toHaveBeenCalledTimes(7);
    const events = execMux.mock.calls.map((c: unknown[]) => {
      const hookName = (c[0] as { args: string[] }).args[2] as string;
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

describe('syncTmuxChangeHooks', () => {
  const srv = (muxRuntime: 'system' | 'managed' | 'misao', type: 'local' | 'agent' = 'local') => ({ name: 's', type, muxRuntime }) as ServerConfig;
  const manager = () => ({ install: vi.fn(async () => {}) });
  const log = { warn: vi.fn() };

  it('installs hooks when a local server is switched back onto tmux', () => {
    const m = manager();
    syncTmuxChangeHooks(m, srv('system'), log);
    syncTmuxChangeHooks(m, srv('managed'), log);
    expect(m.install).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a misao server or a non-local server', () => {
    const m = manager();
    syncTmuxChangeHooks(m, srv('misao'), log);
    syncTmuxChangeHooks(m, srv('system', 'agent'), log);
    expect(m.install).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the install fails', async () => {
    const m = manager();
    m.install.mockRejectedValueOnce(new Error('no tmux server'));
    syncTmuxChangeHooks(m, srv('system'), log);
    await new Promise((r) => setImmediate(r));
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
