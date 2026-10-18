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
