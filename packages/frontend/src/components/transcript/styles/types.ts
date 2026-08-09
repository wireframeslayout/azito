import type { TranscriptEntry } from '../transcriptTypes';

/** スタイル毎のエントリ描画コンポーネントに共通の props。 */
export interface StyleEntryProps {
  entry: TranscriptEntry;
  /** thinking チップの経過秒数表示（C2）に使う、直前エントリのタイムスタンプ。先頭エントリでは null。 */
  prevTimestamp: string | null;
}
