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

/** Terminal WS: windowId → ref → target (fallback). A ref whose kind does not match the server's mux is rejected. */
export function resolveTerminalTarget(params: TerminalTargetParams, deps: TerminalTargetDeps): { server: ServerConfig; ref: MuxRef } | null {
  let server = params.serverName ? deps.serverRepo.findByName(params.serverName) : null;
  let ref: MuxRef | null = null;

  if (params.windowId) {
    const win = deps.windowRepo.findById(Number(params.windowId));
    if (win) {
      ref = win.muxRef ?? muxRefFromTmuxTarget(win.tmuxTarget);
      server = deps.serverRepo.findByName(win.serverName);
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
