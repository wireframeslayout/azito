import { muxRefFromTmuxTarget, parseMuxRef, type MuxRef } from '@azito/shared';
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
}

/** Terminal WS: windowId → ref → target (fallback). A ref (given, or stored on the window row) whose kind does not match the server's mux is rejected. */
export function resolveTerminalTarget(params: TerminalTargetParams, deps: TerminalTargetDeps): { server: ServerConfig; ref: MuxRef } | null {
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
    ref = muxRefFromTmuxTarget(params.target);
  }

  return server && ref ? { server, ref } : null;
}
