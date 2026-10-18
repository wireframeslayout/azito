export const NEAR_BOTTOM_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function getDistanceFromBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

export function isNearBottom(m: ScrollMetrics): boolean {
  return getDistanceFromBottom(m) < NEAR_BOTTOM_THRESHOLD_PX;
}

/**
 * content-visibility の実高さ展開で scrollTop が変わらないまま距離が開く場合に、
 * ユーザーの上スクロールと区別する。scrollTop が前回より減っていなければ prevNear を維持する。
 */
export function nextNearBottom(prevNear: boolean, prevScrollTop: number, m: ScrollMetrics): boolean {
  if (isNearBottom(m)) return true;
  if (m.scrollTop < prevScrollTop) return false;
  return prevNear;
}
