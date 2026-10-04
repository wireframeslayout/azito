import { muxRefFromTmuxTarget, parseMuxRef, stripPaneSuffix, type MuxRef } from '@azito/shared';
import type { IServerRepository, ServerConfig } from '../modules/servers/Server';
import type { IWindowRepository } from '../modules/windows/Window';
import { isRefKindCompatible } from '../modules/windows/windowPaneOps';
import { resolveRawTarget, type RawTargetProbe } from '../modules/tmux/storedWindowKind';

export interface TerminalTargetParams {
  serverName: string | null;
  windowId: string | null;
  ref: string | null;
  target: string | null;
}

export interface TerminalTargetDeps {
  serverRepo: Pick<IServerRepository, 'findByName'>;
  windowRepo: Pick<IWindowRepository, 'findById' | 'findByServerAndTarget'>;
  /** How a raw target is looked up in the muxes of a server (only reached for a target no window row has). */
  probe: RawTargetProbe;
}

/**
 * Terminal WS: windowId → ref → target (fallback). A ref (given, or stored on the window row) whose kind does not match
 * the server's mux is rejected. A raw `target` carries no kind: a registered window (a row for the server and target)
 * is attached by its stored ref, any other target is looked up in the muxes of the server (`resolveRawTarget`: the mux
 * that has the window decides; a window in both throws `AmbiguousWindowKindError`, the client must use windowId / ref).
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
  } else if (params.target && server) {
    // The pane comes from the `pane` param, so a `.N` suffix on the target is not part of the window.
    const target = stripPaneSuffix(params.target);
    const stored = deps.windowRepo.findByServerAndTarget(server.name, target);
    if (stored) {
      const storedRef = stored.muxRef ?? muxRefFromTmuxTarget(stored.tmuxTarget);
      if (isRefKindCompatible(storedRef, server)) ref = storedRef;
    } else {
      ref = (await resolveRawTarget(deps.probe, server, target))?.ref ?? null;
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
