import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import { HOOK_EVENTS, buildHookValue, buildHookSetArgs, buildHookUnsetArgs } from './tmuxHooks';

export class TmuxHookManager {
  private installedServers = new Set<string>();

  constructor(
    private transportFactory: TransportFactory,
    private webhookPort: number,
    private webhookToken: string,
  ) {}

  async install(server: ServerConfig): Promise<void> {
    const transport = this.transportFactory.getTransport(server);
    const base = `http://localhost:${this.webhookPort}/api/hooks/tmux`;
    for (const event of HOOK_EVENTS) {
      const hookValue = buildHookValue(base, event, { token: this.webhookToken, serverName: server.name });
      await transport.execMux({ kind: 'tmux', args: buildHookSetArgs(event, hookValue) });
    }
    this.installedServers.add(server.name);
  }

  async uninstall(server: ServerConfig): Promise<void> {
    const transport = this.transportFactory.getTransport(server);
    for (const event of HOOK_EVENTS) {
      await transport.execMux({ kind: 'tmux', args: buildHookUnsetArgs(event) });
    }
    this.installedServers.delete(server.name);
  }

  async uninstallAll(servers: ServerConfig[]): Promise<void> {
    for (const server of servers) {
      if (this.installedServers.has(server.name)) {
        await this.uninstall(server).catch(() => {});
      }
    }
  }
}

/**
 * Installs the tmux change hooks for a local server whose mux settings changed (a tmux runtime switch needs them on
 * the new tmux server). Failure is not fatal: the hooks are re-installed on the next start.
 */
export function syncTmuxChangeHooks(
  hookManager: Pick<TmuxHookManager, 'install'>,
  next: ServerConfig,
  log: { warn(message: string): void },
): void {
  if (next.type !== 'local') return;
  hookManager.install(next).catch((err) => {
    log.warn(`Failed to install tmux hooks on ${next.name}: ${err}`);
  });
}
