import type { MuxRuntime } from '../Server';

export const MANAGED_TMUX_DIR = '.azito/tmux';
export const MANAGED_SOCKET_NAME = 'azito';

export interface TmuxRuntime {
  bin: string;
  baseArgs: string[];
}

export function resolveTmuxRuntime(muxRuntime: MuxRuntime, homeDir: string): TmuxRuntime {
  if (muxRuntime === 'managed') {
    const dir = `${homeDir}/${MANAGED_TMUX_DIR}`;
    return {
      bin: `${dir}/bin/tmux`,
      baseArgs: ['-L', MANAGED_SOCKET_NAME, '-f', `${dir}/azito.conf`],
    };
  }
  return { bin: 'tmux', baseArgs: [] };
}
