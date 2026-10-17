/** 1回の操作（スクロール到達）あたり、空ページを連続して辿る回数の上限。 */
export const MAX_CONSECUTIVE_EMPTY_OLDER_PAGES = 5;

export interface OlderPageOutcome {
  /** 続きを自動で要求するか。 */
  continuePaging: boolean;
  /** 次回判定に持ち越す、空ページの連続回数。 */
  emptyStreak: number;
}

/**
 * 上方向ページングの1ページ分の応答から、続きを自動で要求するかを決める。
 *
 * 巨大な行は読めずに飛ばされ、entries が空のまま prevOffset だけが減り hasOlder: true で返る。この場合は
 * entries も state も変わらず、自動の続き読み込み（entries の変化で再発火する）も IntersectionObserver
 * （可視性の遷移でしか発火しない）も動かないため、それより前の履歴に辿り着けなくなる。空ページでも
 * prevOffset が前進（減少）していて hasOlder なら続きを要求する。ただし空ページが連続し続ける場合は
 * 上限（既定 5）で止める — 次のスクロール操作で再開する。
 */
export function decideOlderPageContinuation(
  previousStartOffset: number,
  page: { entryCount: number; prevOffset: number; hasOlder: boolean },
  emptyStreak: number,
  maxEmptyStreak: number = MAX_CONSECUTIVE_EMPTY_OLDER_PAGES,
): OlderPageOutcome {
  if (page.entryCount > 0) return { continuePaging: false, emptyStreak: 0 };
  if (!page.hasOlder || page.prevOffset >= previousStartOffset) return { continuePaging: false, emptyStreak: 0 };
  const nextStreak = emptyStreak + 1;
  return { continuePaging: nextStreak <= maxEmptyStreak, emptyStreak: nextStreak };
}
