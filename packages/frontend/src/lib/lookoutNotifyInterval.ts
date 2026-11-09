export const LOOKOUT_NOTIFY_INTERVAL_KEY = 'azito-lookout-notify-interval';
export type LookoutNotifyInterval = 'immediate' | '5min' | '15min' | 'off';
export const LOOKOUT_NOTIFY_INTERVAL_CHANGED = 'azito-lookout-notify-interval-changed';
export function readLookoutNotifyInterval(): LookoutNotifyInterval {
  try {
    const value = localStorage.getItem(LOOKOUT_NOTIFY_INTERVAL_KEY);
    if (value === 'immediate' || value === '5min' || value === '15min' || value === 'off') return value;
  } catch { /* Storage unavailable: use the default. */ }
  return '5min';
}
export function writeLookoutNotifyInterval(value: LookoutNotifyInterval): void {
  try { localStorage.setItem(LOOKOUT_NOTIFY_INTERVAL_KEY, value); } catch { /* Storage unavailable: keep the setting for this tab. */ }
  window.dispatchEvent(new CustomEvent(LOOKOUT_NOTIFY_INTERVAL_CHANGED, { detail: value }));
}
