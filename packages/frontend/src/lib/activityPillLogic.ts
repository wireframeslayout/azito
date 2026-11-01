import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';

// MobileStatusBar（components/workspace/MobileStatusBar.tsx、旧 FloatingActivityPill）の集計
// ロジックを純粋関数として切り出したもの（Issue #338 T2/T3）。コンポーネント本体は React
// Testing Library を使わない現状のテスト構成（vitest environment: 'node', *.test.ts のみ）
// のため、jsdom なしでユニットテストできるようここへ抽出している。

export interface BlockedAwareGroup {
  groupKey: string;
  rows: ActiveWindowRow[];
  /** グループ内のいずれかの行が blocked なら true。最初の行だけでなく全行を見る
   *  （同一タスク配下に複数ウィンドウがある場合、後続行の blocked が無視されないように）。 */
  isBlocked: boolean;
  /** タイトル・メタ情報の算出に使う代表行（先頭で見つかった running 行）。 */
  representativeRow: ActiveWindowRow;
}

/**
 * running 行をタスク単位（taskId がなければウィンドウ単位）でグループ化し、グループ内に
 * 1件でも blocked な行があれば isBlocked を立てる。
 */
export function groupRunningRows(rows: ActiveWindowRow[]): BlockedAwareGroup[] {
  const map = new Map<string, BlockedAwareGroup>();
  for (const row of rows) {
    if (row.status !== 'running') continue;
    const groupKey = row.taskId != null ? `task:${row.taskId}` : `window:${row.key}`;
    const existing = map.get(groupKey);
    if (existing) {
      existing.rows.push(row);
      if (row.activityStatus === 'blocked') existing.isBlocked = true;
      continue;
    }
    map.set(groupKey, {
      groupKey,
      rows: [row],
      isBlocked: row.activityStatus === 'blocked',
      representativeRow: row,
    });
  }
  return Array.from(map.values());
}
