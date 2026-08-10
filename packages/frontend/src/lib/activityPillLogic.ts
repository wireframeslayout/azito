import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';

// FloatingActivityPill（components/workspace/FloatingActivityPill.tsx）の集計ロジックを
// 純粋関数として切り出したもの（Issue #338 T2/T3）。コンポーネント本体は React
// Testing Library を使わない現状のテスト構成（vitest environment: 'node', *.test.ts のみ）
// のため、jsdom なしでユニットテストできるようここへ抽出している。

export interface BlockedAwareGroup {
  groupKey: string;
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
      if (row.activityStatus === 'blocked') existing.isBlocked = true;
      continue;
    }
    map.set(groupKey, {
      groupKey,
      isBlocked: row.activityStatus === 'blocked',
      representativeRow: row,
    });
  }
  return Array.from(map.values());
}

const READ_KEY_SEP = '::';

/**
 * 既読IDを `key::finishedAt` で作る。row.key だけを既読キーにすると、同一ウィンドウが
 * 再稼働→再完了した際に finishedAt が更新されても同じキーのままなため既読扱いが残り、
 * 新しい完了が未読カウントされなくなる。finishedAt を含めることで完了イベントごとに
 * 別IDになる。
 */
export function readKeyFor(row: Pick<ActiveWindowRow, 'key' | 'finishedAt'>): string {
  return `${row.key}${READ_KEY_SEP}${row.finishedAt ?? 0}`;
}

function finishedAtOfReadKey(readKey: string): number {
  const idx = readKey.lastIndexOf(READ_KEY_SEP);
  if (idx < 0) return 0;
  const parsed = Number(readKey.slice(idx + READ_KEY_SEP.length));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 時間窓（cutoffMs 以降）から外れた既読IDを取り除いた新しい Set を返す。 */
export function pruneStaleReadKeys(keys: Iterable<string>, cutoffMs: number): Set<string> {
  return new Set(Array.from(keys).filter((k) => finishedAtOfReadKey(k) >= cutoffMs));
}
