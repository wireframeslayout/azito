// 完了行（finished）のキー規約と純粋なリスト操作。AgentActivityProvider（useAgentActivity.tsx）が
// 唯一の適用箇所で、表示側は適用済みの結果だけを見る。React に依存しない純関数として切り出してある
// のは、寿命・重複・再完了の規則をテストで固定するため。

/** 完了行1件。表示に必要な最小限のメタと完了時刻を持つ。 */
export interface FinishedEntry {
  serverName: string;
  target: string;
  label?: string;
  taskId?: number;
  projectId?: number;
  finishedAt: number;
  paneName?: string;
}

import { windowKey as activityKey } from '@azito/shared';
export { activityKey };

/**
 * 完了行の寿命。読み込み時・定期・保存時の3箇所で同じ値が適用される（以前は SPバーの表示
 * フィルタだけが1時間で切っており、localStorage の実体は無期限に積み上がっていた）。
 */
export const FINISHED_TTL_MS = 60 * 60 * 1000;

/** TTL を過ぎた完了行を落とす。落とすものが無ければ同一参照を返す（無駄な再レンダリングを避ける）。 */
export function pruneFinished(entries: FinishedEntry[], now: number): FinishedEntry[] {
  const kept = entries.filter((e) => now - e.finishedAt < FINISHED_TTL_MS);
  return kept.length === entries.length ? entries : kept;
}

/**
 * 完了行を追加する。同じウィンドウの行が既にあれば**置き換える**（破棄しない）: ポーリング間隔の
 * 間に次のターンが始まって終わった場合、古い finishedAt のまま据え置くと「さっき完了した」ことが
 * 表示にも未読数にも反映されない（未読判定は finishedAt を含むキーで行うため、置き換えることで
 * 自動的に未読へ戻る）。
 */
export function upsertFinished(entries: FinishedEntry[], entry: FinishedEntry): FinishedEntry[] {
  const key = activityKey(entry.serverName, entry.target);
  const idx = entries.findIndex((e) => activityKey(e.serverName, e.target) === key);
  if (idx === -1) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
}

/** 指定キーの完了行を取り除く（ウィンドウ削除・再稼働・既読化などの経路で使う）。 */
export function removeFinished(entries: FinishedEntry[], key: string): FinishedEntry[] {
  const kept = entries.filter((e) => activityKey(e.serverName, e.target) !== key);
  return kept.length === entries.length ? entries : kept;
}
