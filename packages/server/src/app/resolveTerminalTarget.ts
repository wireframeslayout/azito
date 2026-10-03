import { muxKindForRuntime, muxRefFromTmuxTarget, parseMuxRef, stripPaneSuffix, type MuxRef } from '@azito/shared';
import type { IServerRepository, ServerConfig } from '../modules/servers/Server';
import type { IWindowRepository } from '../modules/windows/Window';
import { isRefKindCompatible } from '../modules/windows/windowPaneOps';

export interface TerminalTargetParams {
  serverName: string | null;
  windowId: string | null;
  ref: string | null;
  target: string | null;
}

export interface TerminalTargetDeps {
  serverRepo: Pick<IServerRepository, 'findByName'>;
  windowRepo: Pick<IWindowRepository, 'findById'>;
  /** Resolves a name-based target through the server's mux driver; null when the target names no single window. */
  resolveDriverRef: (server: ServerConfig, target: string) => Promise<MuxRef | null>;
}

/**
 * Terminal WS: windowId → ref → target (fallback). A ref (given, or stored on the window row) whose kind does not match
 * the server's mux is rejected. A `target` is read as a tmux target only on a tmux server; on any other mux it goes
 * through the driver and is rejected (null) when the driver cannot resolve it.
 */
export async function resolveTerminalTarget(params: TerminalTargetParams, deps: TerminalTargetDeps): Promise<{ server: ServerConfig; ref: MuxRef } | null> {
  let server = params.serverName ? deps.serverRepo.findByName(params.serverName) : null;
  let ref: MuxRef | null = null;

  if (params.windowId) {
    const win = deps.windowRepo.findById(Number(params.windowId));
    if (win) {
      const winServer = deps.serverRepo.findByName(win.serverName);
      const winRef = win.muxRef ?? muxRefFromTmuxTarget(win.tmuxTarget);
      // A row registered with a ref of another kind (e.g. a tmux ref on a misao server) cannot be attached by that server's driver.
      if (isRefKindCompatible(winRef, winServer)) ref = winRef;
      server = winServer;
    }
  } else if (params.ref) {
    try {
      const parsed = parseMuxRef(decodeURIComponent(params.ref));
      if (isRefKindCompatible(parsed, server)) ref = parsed;
    } catch { /* invalid ref */ }
  } else if (params.target) {
    if (server && muxKindForRuntime(server.muxRuntime) !== 'tmux') {
      // The pane comes from the `pane` param, so a `.N` suffix on the target is not part of the window.
      ref = await deps.resolveDriverRef(server, stripPaneSuffix(params.target));
    } else {
      ref = muxRefFromTmuxTarget(params.target);
    }
  }

  return server && ref ? { server, ref } : null;
}

/** The pane of a terminal WS: the `pane` param, else the `.N` suffix of a `target`, else 1. */
export function terminalPaneOrdinal(paneParam: string | null, target: string | null): number {
  if (paneParam) return Number(paneParam);
  const suffix = target ? /\.(\d+)$/.exec(target) : null;
  return suffix ? Number(suffix[1]) : 1;
}
