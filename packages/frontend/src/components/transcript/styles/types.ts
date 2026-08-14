import type { EntryGroup } from '../groupEntries';

/** スタイル毎のグループ描画コンポーネントに共通の props（B1: ロールグルーピング）。 */
export interface StyleGroupProps {
  group: EntryGroup;
  /** thinking チップの経過秒数表示（C2）に使う、グループ先頭エントリの直前エントリのタイムスタンプ。先頭グループでは null。 */
  prevTimestamp: string | null;
  /** assistant 見出しに表示するラベル（agentType.toUpperCase()）。bubble/flow の GroupHeading にのみ使われる。 */
  agentLabel: string;
}
