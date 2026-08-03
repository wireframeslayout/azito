import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';

const HOOK_EVENTS = [
  'window-linked',
  'window-unlinked',
  'after-rename-window',
  'after-kill-pane',
  'session-window-changed',
  'session-closed',
  'after-select-pane',
] as const;
const HOOK_INDEX = 42;

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
    const serverParam = encodeURIComponent(server.name);
    for (const event of HOOK_EVENTS) {
      const hookValue = `run-shell "curl -sf -o /dev/null -X POST -H 'Authorization: Bearer ${this.webhookToken}' '${base}?event=${event}&server=${serverParam}&session=#{hook_session_name}' 2>/dev/null &"`;
      await transport.execTmux(['set-hook', '-g', `${event}[${HOOK_INDEX}]`, hookValue]);
    }
    this.installedServers.add(server.name);
  }

  async uninstall(server: ServerConfig): Promise<void> {
    const transport = this.transportFactory.getTransport(server);
    for (const event of HOOK_EVENTS) {
      await transport.execTmux(['set-hook', '-gu', `${event}[${HOOK_INDEX}]`]);
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
