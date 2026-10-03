import type { ServerConfig } from './Server';

/** Splits servers into those driven by tmux and those skipped by tmux-only work (startup hooks, linked-session GC, shutdown). */
export function partitionByTmuxRuntime<T extends Pick<ServerConfig, 'defaultMux'>>(servers: T[]): { tmux: T[]; skipped: T[] } {
  const tmux: T[] = [];
  const skipped: T[] = [];
  for (const server of servers) {
    (server.defaultMux === 'tmux' ? tmux : skipped).push(server);
  }
  return { tmux, skipped };
}
