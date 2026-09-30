import type { ServerConfig } from '../servers/Server';
import type { ExecResult } from '../servers/transport/ServerTransport';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { Window, IWindowRepository } from './Window';
import { isPrimaryTaskWindow } from './Window';
import { type MuxRef, type PaneHandle, type PaneOrdinal, parseMuxRef, muxRefFromTmuxTarget, tmuxTargetFromMuxRef } from '@azito/shared';
import { resolveKillOutcome, type KillOutcome } from '../tmux/killOutcome';

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
      const target = tmuxTargetFromMuxRef(ref);
      windowRepo.removeByServerAndTarget(server.name, target);
    }
  };

  const windowName = dbWindow ? windowNameFromTarget(dbWindow.tmuxTarget) : ref.window;
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
