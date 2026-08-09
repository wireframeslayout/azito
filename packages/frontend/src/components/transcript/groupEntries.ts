import type { TranscriptEntry, TranscriptEntryType } from './transcriptTypes';

/** ロールグルーピング（B1）で作る、連続する同一種別エントリの束。 */
export interface EntryGroup {
  type: TranscriptEntryType;
  entries: TranscriptEntry[];
}

/**
 * 連続する同一 type のエントリを1グループにまとめる（垂直密度改善: ロール見出し・時刻の反復を減らす）。
 * ただし tool は直前が assistant なら assistant グループに吸収する — tool_result は直前の
 * assistant の道具作業の続きとして同グループで見せるため。assistant グループは、そのまま
 * 後続の連続する tool エントリを取り込み続ける。
 */
export function groupEntries(entries: TranscriptEntry[]): EntryGroup[] {
  const groups: EntryGroup[] = [];

  for (const entry of entries) {
    const last = groups[groups.length - 1];

    if (last && (last.type === entry.type || (entry.type === 'tool' && last.type === 'assistant'))) {
      last.entries.push(entry);
      continue;
    }

    groups.push({ type: entry.type, entries: [entry] });
  }

  return groups;
}
