import type { ServerConfig } from '../servers/Server';
import type { ExecResult } from '../servers/transport/ServerTransport';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { Window, IWindowRepository } from './Window';
import { isPrimaryTaskWindow } from './Window';
import { type MuxRef, type PaneHandle, type PaneOrdinal, parseMuxRef, muxRefFromTmuxTarget, muxKindForRuntime, isPaneHandleLike, asPaneHandle } from '@azito/shared';
import { resolveKillOutcome, type KillOutcome } from '../tmux/killOutcome';
import { muxWindowTarget } from '../tmux/muxWindowTarget';
import { uiTokenEnvForServer } from '../../shared/auth/uiTokenEnv';

// ─── Resolution helpers ───

export function resolveWindowById(
  windowRepo: IWindowRepository,
  id: number,
): { window: Window; ref: MuxRef } {
  const win = windowRepo.findById(id);
  if (!win) throw Object.assign(new Error('Window not found'), { statusCode: 404 });
  const ref = win.muxRef ?? muxRefFromTmuxTarget(win.tmuxTarget);
  return { window: win, ref };
}

export function resolveRefFromParam(encoded: string): MuxRef {
  try {
    return parseMuxRef(decodeURIComponent(encoded));
  } catch {
    throw Object.assign(new Error('Invalid ref parameter'), { statusCode: 400 });
  }
}

/** A ref is only usable on a server whose driver speaks the same kind; an unknown server accepts tmux refs only. */
export function isRefKindCompatible(ref: MuxRef, server: Pick<ServerConfig, 'muxRuntime'> | null | undefined): boolean {
  return ref.kind === (server ? muxKindForRuntime(server.muxRuntime) : 'tmux');
}

export function resolveRefForServer(encoded: string, server: Pick<ServerConfig, 'muxRuntime'>): MuxRef {
  const ref = resolveRefFromParam(encoded);
  if (!isRefKindCompatible(ref, server)) {
    throw Object.assign(new Error('Invalid ref parameter'), { statusCode: 400 });
  }
  return ref;
}

export async function resolvePaneHandle(
  muxClient: IMuxClient,
  server: ServerConfig,
  ref: MuxRef,
  ordinal: PaneOrdinal,
): Promise<PaneHandle> {
  try {
    return await muxClient.resolvePane(server, ref, ordinal);
  } catch {
    throw Object.assign(new Error(`Pane ordinal ${ordinal} not found`), { statusCode: 404 });
  }
}

/**
 * Deletes one pane of the window `ref`. Addressed by the pane's stable handle (what the session listing reported)
 * when given: ordinals shift when a sibling goes, so re-resolving an ordinal can delete a different pane. A handle
 * that no longer exists is already deleted (success); one that lives in another window is refused. Without a handle
 * the ordinal is resolved as before.
 */
export async function closePaneInWindow(
  muxClient: IMuxClient,
  server: ServerConfig,
  ref: MuxRef,
  target: { ordinal: PaneOrdinal; handle?: string },
): Promise<void> {
  let handle: PaneHandle;
  if (target.handle === undefined) {
    handle = await resolvePaneHandle(muxClient, server, ref, target.ordinal);
  } else {
    if (!isPaneHandleLike(target.handle, ref.kind)) {
      throw Object.assign(new Error('Invalid pane handle'), { statusCode: 400 });
    }
    handle = asPaneHandle(target.handle);
    const members = await muxClient.listPanesByRef(server, ref).catch(() => []);
    if (!members.some((pane) => pane.handle === handle)) {
      if ((await muxClient.refFromPaneHandle(server, handle)) === null) return;
      throw Object.assign(new Error('Pane does not belong to this window'), { statusCode: 404 });
    }
  }
  const outcome = await resolveKillOutcome(muxClient.closePane(server, handle));
  if (!outcome.success) {
    throw Object.assign(new Error(`kill-pane failed: ${outcome.result.stderr || outcome.result.stdout}`), { statusCode: 500 });
  }
}

// ─── Adding a pane to an existing window ───

export interface PaneAddEnvDeps {
  uiToken: string;
  /** Masked-only env of a secondary task-owned window (never a task token). */
  buildSecondaryWindowEnv: (taskId: number, server: ServerConfig) => Record<string, string>;
}

export type PaneAddEnv =
  | { ok: true; extraEnv: Record<string, string> }
  | { ok: false; status: 409; body: { error: string; message: string } };

/**
 * Decides, for every route that adds a pane to an existing window, whether that is allowed and with which env.
 * Must be called inside the per-server `serverIsolationMutex` lock, with the server row and window row fetched
 * inside it, so the decision is made against the same isolation state the pane is created under.
 *
 * - A task's primary window: refused. Its first pane holds the live task-token generation and the plaintext is
 *   never stored, so no env can give a new pane the same generation without rotating it; respawn the window first.
 * - A secondary task window: its masked-only env.
 * - Any other window: the manual-window env (UI token, or the isolation mask on an isolated server).
 */
export function resolvePaneAddEnv(window: Window | undefined, server: ServerConfig, deps: PaneAddEnvDeps): PaneAddEnv {
  if (window && window.taskId !== null) {
    if (isPrimaryTaskWindow(window)) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'primary_task_window_pane_add_unsupported',
          message: "Cannot add a pane to a task's primary window directly — respawn the window first, then add panes.",
        },
      };
    }
    return { ok: true, extraEnv: deps.buildSecondaryWindowEnv(window.taskId, server) };
  }
  return { ok: true, extraEnv: uiTokenEnvForServer(deps.uiToken, server) };
}

// ─── Kill window (shared across windowId / ref / legacy target routes) ───

export interface KillWindowDeps {
  muxClient: IMuxClient;
  windowRepo: IWindowRepository;
  destroyPrimaryTaskWindow?: (
    taskId: number,
    windowName: string,
    serverName: string,
    target: string,
    reason: string,
    kill: () => Promise<ExecResult>,
    onDestroyed: () => void,
  ) => Promise<KillOutcome>;
  notifySessionsChanged: (serverName: string) => void;
}

function windowNameFromTarget(tmuxTarget: string): string | undefined {
  const idx = tmuxTarget.indexOf(':');
  if (idx < 0) return undefined;
  return tmuxTarget.slice(idx + 1);
}

export async function killWindowCore(
  deps: KillWindowDeps,
  server: ServerConfig,
  ref: MuxRef,
  dbWindow: Window | undefined,
): Promise<{ ok: boolean; identity?: { sessionName: string; windowName: string } }> {
  const { muxClient, windowRepo } = deps;

  const identity = { sessionName: ref.workspace, windowName: ref.window };

  const cleanupWindowRows = () => {
    if (dbWindow) {
      windowRepo.remove(dbWindow.id);
    } else {
      const target = muxWindowTarget(ref);
      windowRepo.removeByServerAndTarget(server.name, target);
    }
  };

  // task.tmuxWindow holds the window's identity (mux_ref.window), which tmux_target may not carry in the same form.
  const windowName = dbWindow ? (dbWindow.muxRef?.window ?? windowNameFromTarget(dbWindow.tmuxTarget)) : ref.window;
  let outcome: KillOutcome;

  if (dbWindow && dbWindow.taskId !== null && isPrimaryTaskWindow(dbWindow) && windowName && deps.destroyPrimaryTaskWindow) {
    outcome = await deps.destroyPrimaryTaskWindow(
      dbWindow.taskId,
      windowName,
      server.name,
      dbWindow.tmuxTarget,
      'window_killed_via_window_route',
      () => muxClient.closeWindow(server, ref),
      cleanupWindowRows,
    );
  } else {
    outcome = await resolveKillOutcome(muxClient.closeWindow(server, ref));
    if (outcome.success) cleanupWindowRows();
  }

  if (!outcome.success) {
    throw Object.assign(
      new Error(`kill-window failed: ${outcome.result.stderr || outcome.result.stdout}`),
      { statusCode: 500 },
    );
  }

  deps.notifySessionsChanged(server.name);
  return { ok: true, identity };
}
