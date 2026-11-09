import { useEffect, useState } from 'react';
import { LOOKOUT_NOTIFY_INTERVAL_CHANGED, LOOKOUT_NOTIFY_INTERVAL_KEY, readLookoutNotifyInterval, type LookoutNotifyInterval } from '../lib/lookoutNotifyInterval';

export function useLookoutNotifyInterval(): LookoutNotifyInterval {
  const [interval, setNotifyInterval] = useState(readLookoutNotifyInterval);
  useEffect(() => {
    const changed = (event: Event) => setNotifyInterval((event as CustomEvent<LookoutNotifyInterval>).detail);
    const storage = (event: StorageEvent) => { if (event.key === LOOKOUT_NOTIFY_INTERVAL_KEY || event.key === null) setNotifyInterval(readLookoutNotifyInterval()); };
    window.addEventListener(LOOKOUT_NOTIFY_INTERVAL_CHANGED, changed);
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener(LOOKOUT_NOTIFY_INTERVAL_CHANGED, changed); window.removeEventListener('storage', storage); };
  }, []);
  return interval;
}
