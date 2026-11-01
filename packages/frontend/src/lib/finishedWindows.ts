// 完了行（finished）のキー規約と純粋なリスト操作。AgentActivityProvider（useAgentActivity.tsx）が
// 唯一の適用箇所で、表示側は適用済みの結果だけを見る。React に依存しない純関数として切り出してある
// のは、寿命・重複・再完了の規則をテストで固定するため。

/** 完了行1件。表示に必要な最小限のメタと完了時刻を持つ。 */
export interface FinishedEntry {
  serverName: string;
  target: string;
  windowId?: number;
  label?: string;
  labelSource?: 'auto' | 'user';
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  paneTitle?: string;
  paneCommand?: string;
  taskId?: number;
  projectId?: number;
  finishedAt: number;
  seenAt?: number;
  paneName?: string;
}

import { isSameWindowTarget, windowKey } from '@azito/shared';
import { DEFAULT_FINISHED_RETENTION, type FinishedRetentionSettings } from './finishedRetentionSettings';

export function activityKey(serverName: string, target: string, windowId?: number): string {
  if (windowId != null) return `wid:${windowId}`;
  return windowKey(serverName, target);
}

export function activityKeyForEntry(entry: FinishedEntry): string {
  return activityKey(entry.serverName, entry.target, entry.windowId);
}

/**
 * 完了行の寿命。読み込み時・定期・保存時の3箇所で同じ値が適用される（以前は SPバーの表示
 * フィルタだけが1時間で切っており、localStorage の実体は無期限に積み上がっていた）。
 */
export const FINISHED_TTL_MS = 60 * 60 * 1000;

/** TTL を過ぎた完了行を落とす。落とすものが無ければ同一参照を返す（無駄な再レンダリングを避ける）。 */
export function pruneFinished(entries: FinishedEntry[], now: number, settings: FinishedRetentionSettings = DEFAULT_FINISHED_RETENTION): FinishedEntry[] {
  const unexpired = entries.filter((e) => now - e.finishedAt < settings.retentionMs);
  const keptSeen = new Set(unexpired.filter((e) => e.seenAt != null).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, settings.maxCount));
  const kept = unexpired.filter((e) => e.seenAt == null || keptSeen.has(e));
  return kept.length === entries.length ? entries : kept;
}

/**
 * 完了行を追加する。同じウィンドウの行が既にあれば**置き換える**（破棄しない）: ポーリング間隔の
 * 間に次のターンが始まって終わった場合、古い finishedAt のまま据え置くと「さっき完了した」ことが
 * 表示にも未読数にも反映されない（未読判定は finishedAt を含むキーで行うため、置き換えることで
 * 自動的に未読へ戻る）。
 */
export function upsertFinished(entries: FinishedEntry[], entry: FinishedEntry): FinishedEntry[] {
  const key = activityKeyForEntry(entry);
  const idx = entries.findIndex((e) => activityKeyForEntry(e) === key);
  if (idx === -1) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
}

/** 削除通知では ID が片方にない場合、サーバーと target で照合する。 */
export function removeDeletedFinished(
  entries: FinishedEntry[], deleted: Pick<FinishedEntry, 'serverName' | 'target' | 'windowId'>,
): FinishedEntry[] {
  const kept = entries.filter((entry) => {
    if (entry.windowId != null && deleted.windowId != null) return entry.windowId !== deleted.windowId;
    return entry.serverName !== deleted.serverName || !isSameWindowTarget(entry.target, deleted.target);
  });
  return kept.length === entries.length ? entries : kept;
}

/** Preserve display metadata omitted by the completion event. */
export function mergeFinishedEntry(entry: FinishedEntry, previous?: Omit<FinishedEntry, 'finishedAt'>): FinishedEntry {
  return {
    ...entry,
    taskId: entry.taskId ?? previous?.taskId,
    projectId: entry.projectId ?? previous?.projectId,
    label: entry.label ?? previous?.label,
    labelSource: entry.labelSource ?? previous?.labelSource,
    taskTitle: entry.taskTitle ?? previous?.taskTitle,
    workerType: entry.workerType ?? previous?.workerType,
    windowType: entry.windowType ?? previous?.windowType,
    paneTitle: entry.paneTitle || previous?.paneTitle,
    paneCommand: entry.paneCommand ?? previous?.paneCommand,
    paneName: entry.paneName || previous?.paneName,
  };
}
