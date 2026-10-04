import type { MuxWorkspace } from '@azito/shared';
import type { ServerConfig } from './Server';
import type { IWindowRepository } from '../windows/SqliteWindowRepository';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';

export interface IsolationBlockerDeps {
  windowRepo: Pick<IWindowRepository, 'findByServer'>;
  muxDriverRegistry: Pick<MuxDriverRegistry, 'downKinds' | 'resolve'>;
}

/**
 * What blocks declaring a server isolated (a false->true isolation_intent transition, or a cleanup retry): registered
 * agent / task windows, live workspaces, or a workspace listing that cannot be trusted (fail closed). Null when clear.
 * Moved out of servers/routes.ts unchanged except for the per-mux check (#311).
 */
export async function checkIsolationBlockers(
deps: IsolationBlockerDeps,
serverName: string,
srv: ServerConfig,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const allWindows = deps.windowRepo.findByServer(serverName);
  const riskyWindows = allWindows.filter((w) => w.windowType === 'agent' || w.taskId !== null);
  if (riskyWindows.length > 0) {
    return {
      status: 409,
      body: {
        error: 'isolation_intent_blocked_by_windows',
        message: `${riskyWindows.length} 件のウィンドウがこのサーバー上に登録されているため隔離を有効化できません。対象ウィンドウを閉じてから再度有効化してください。`,
        windowCount: riskyWindows.length,
      },
    };
  }
  // Fail closed for a mux that cannot be listed now when it matters here: the server's default mux, or a mux some
  // window row of this server lives in. (listWorkspacesStrict only calls the usable muxes, so it cannot see them.)
  const unreadable = deps.muxDriverRegistry.downKinds(srv)
    .filter((d) => d.kind === srv.defaultMux || allWindows.some((w) => (w.muxRef?.kind ?? 'tmux') === d.kind));
  if (unreadable.length > 0) {
    const detail = unreadable.map((d) => `${d.kind}: ${d.reason}`).join(', ');
    return {
      status: 409,
      body: {
        error: 'isolation_intent_blocked_by_session_check_failure',
        message: `隔離対象サーバーのワークスペース一覧取得に失敗したため、安全側に倒して隔離を有効化できません（${detail}）。サーバーの疎通を確認してから再度お試しください。`,
      },
    };
  }
  const driver = deps.muxDriverRegistry.resolve(srv);
  let liveWorkspaces: MuxWorkspace[];
  try {
    liveWorkspaces = await driver.listWorkspacesStrict(srv);
  } catch (err: unknown) {
    return {
      status: 409,
      body: {
        error: 'isolation_intent_blocked_by_session_check_failure',
        message: `隔離対象サーバーのワークスペース一覧取得に失敗したため、安全側に倒して隔離を有効化できません（${(err as Error).message}）。サーバーの疎通を確認してから再度お試しください。`,
      },
    };
  }
  if (liveWorkspaces.length > 0) {
    return {
      status: 409,
      body: {
        error: 'isolation_intent_blocked_by_live_sessions',
        message: `${liveWorkspaces.length} 件の稼働中ワークスペースがこのサーバー上に存在するため隔離を有効化できません。ワークスペースを終了してから再度有効化してください。`,
        sessionCount: liveWorkspaces.length,
      },
    };
  }
  return null;
}
