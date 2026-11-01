import { isSameWindowTarget } from '@azito/shared';
import type { NotificationEvent } from '../types/notification';

type Rename = Extract<NotificationEvent, { type: 'window:renamed' }>['payload'];

export function renameActivity<T extends { serverName: string; target: string; windowId?: number; label?: string; labelSource?: 'auto' | 'user' }>(entry: T, event: Rename): T {
  if (event.windowId != null || entry.windowId != null || entry.serverName !== event.serverName || !isSameWindowTarget(entry.target, event.target)) return entry;
  return { ...entry, label: event.newName, labelSource: 'user' };
}

