import type { Window } from '../windows/Window';

/**
 * サブエージェント API の親セッション照合に使う、窓ごとの直近の解決結果。
 *
 * 子の会話は 2 秒ごとに取得されるため、その都度 `WindowSessionResolver.resolve()`（pane 一覧・
 * プロセス一覧・セッション実在確認）を走らせると重い。一覧 API と、キャッシュが無い／古い／一致しない
 * ときの読み取りだけが解決を行い、その結果を ttlMs の間だけ使い回す。
 *
 * 窓の紐付け（サーバー・agentSessionId・taskId）が DB 上で変わったら、TTL 内でも使わない
 * （SessionStart フックによる親の切り替えを即座に反映するため）。
 */
export class ParentSessionCache {
  private readonly entries = new Map<number, { link: string; sessionId: string; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

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
    this.entries.set(window.id, { link: linkOf(window), sessionId, expiresAt: now + this.ttlMs });
  }

  delete(windowId: number): void {
    this.entries.delete(windowId);
  }
}

function linkOf(window: Window): string {
  return JSON.stringify([window.serverName, window.agentSessionId, window.taskId]);
}
