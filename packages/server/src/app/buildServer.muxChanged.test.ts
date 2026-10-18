import { describe, it, expect, vi } from 'vitest';
import type { ServerConfig } from '../modules/servers/Server';
import { syncTmuxChangeHooks } from '../modules/tmux/TmuxHookManager';

function makeSrv(name: string): ServerConfig {
  return { name, type: 'local' } as ServerConfig;
}

function simulateOnMuxChanged(
  hookManager: { uninstall(server: ServerConfig): Promise<void>; install(server: ServerConfig): Promise<void> },
  previous: ServerConfig,
  next: ServerConfig,
  log: { warn(message: string): void },
): void {
  void hookManager.uninstall(previous)
    .catch((err: unknown) => { log.warn(`Failed to uninstall tmux hooks on ${previous.name}: ${err}`); })
    .then(() => syncTmuxChangeHooks(hookManager, next, log));
}

describe('onMuxChanged hook sequencing', () => {
  it('does not call install before uninstall resolves', async () => {
    const order: string[] = [];
    let resolveUninstall!: () => void;
    const uninstallPromise = new Promise<void>((r) => { resolveUninstall = r; });

    const hookManager = {
      uninstall: vi.fn(() => { order.push('uninstall'); return uninstallPromise; }),
      install: vi.fn(async () => { order.push('install'); }),
    };
    const log = { warn: vi.fn() };

    simulateOnMuxChanged(hookManager, makeSrv('old'), makeSrv('new'), log);

    await Promise.resolve();
    expect(order).toEqual(['uninstall']);
    expect(hookManager.install).not.toHaveBeenCalled();

    resolveUninstall();
    await new Promise((r) => setTimeout(r, 0));

    expect(hookManager.install).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['uninstall', 'install']);
  });

  it('calls install even when uninstall rejects', async () => {
    const hookManager = {
      uninstall: vi.fn(async () => { throw new Error('uninstall failed'); }),
      install: vi.fn(async () => {}),
    };
    const log = { warn: vi.fn() };

    simulateOnMuxChanged(hookManager, makeSrv('old'), makeSrv('new'), log);

    await new Promise((r) => setTimeout(r, 0));

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('uninstall failed'));
    expect(hookManager.install).toHaveBeenCalledTimes(1);
  });
});
