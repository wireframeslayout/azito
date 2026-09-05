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
      await transport.execTmux(buildHookSetArgs(event, hookValue));
    }
    this.installedServers.add(server.name);
  }

  async uninstall(server: ServerConfig): Promise<void> {
    const transport = this.transportFactory.getTransport(server);
    for (const event of HOOK_EVENTS) {
      await transport.execTmux(buildHookUnsetArgs(event));
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
