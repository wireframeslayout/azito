import type { Window } from '../windows/Window';

/** 解決結果を使い回す時間。DB の紐付けで裏付けられた親だけ長く持つ。 */
export interface ParentSessionTtls {
  /** 解決した親が窓の DB 上の agentSessionId と一致するとき（親の切り替えは DB の紐付けの変化で即座に分かる）。 */
  linkedMs: number;
  /** それ以外（cwd 照合フォールバック・タスク経由など。親の切り替えは解決し直すまで分からない）。 */
  unlinkedMs: number;
}

/**
 * サブエージェント API の親セッション照合に使う、窓ごとの直近の解決結果。
 *
 * 子の一覧は 5 秒ごと、子の会話は 2 秒ごとに取得されるため、その都度 `WindowSessionResolver.resolve()`
 * （pane 一覧・プロセス一覧・セッション実在確認）を走らせると重い。キャッシュが無い／古い／一致しない
 * ときだけ解決を行い、その結果を TTL の間だけ使い回す。
 *
 * 窓の紐付け（サーバー・agentSessionId・taskId）が DB 上で変わったら、TTL 内でも使わない
 * （SessionStart フックによる親の切り替えを即座に反映するため）。この即時反映が効くのは解決結果が
 * DB の agentSessionId そのものである場合だけなので、長い TTL はその場合に限り、ほかは短い TTL にする
 * （古い親を長く返さないため）。
 */
export class ParentSessionCache {
  private readonly entries = new Map<number, { link: string; sessionId: string; expiresAt: number }>();

  constructor(private readonly ttls: ParentSessionTtls, private readonly now: () => number = Date.now) {}

  get(window: Window): string | undefined {
    const entry = this.entries.get(window.id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now() || entry.link !== linkOf(window)) {
      this.entries.delete(window.id);
      return undefined;
    }
    return entry.sessionId;
  }

  set(window: Window, sessionId: string): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    const ttlMs = window.agentSessionId !== null && window.agentSessionId === sessionId ? this.ttls.linkedMs : this.ttls.unlinkedMs;
    this.entries.set(window.id, { link: linkOf(window), sessionId, expiresAt: now + ttlMs });
  }

  delete(windowId: number): void {
    this.entries.delete(windowId);
  }
}

function linkOf(window: Window): string {
  return JSON.stringify([window.serverName, window.agentSessionId, window.taskId, window.claudeConfigDir, window.claudePaneSessions, window.paneLayout]);
}
