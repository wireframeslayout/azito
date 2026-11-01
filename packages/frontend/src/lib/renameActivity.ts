import { isSameWindowTarget } from '@azito/shared';
import type { WindowRenamedPayload } from '../types/notification';

export function renameActivity<T extends { serverName: string; target: string; windowId?: number; label?: string; labelSource?: 'auto' | 'user' }>(entry: T, event: WindowRenamedPayload): T {
  if (event.windowId != null || entry.windowId != null || entry.serverName !== event.serverName || !isSameWindowTarget(entry.target, event.target)) return entry;
  return { ...entry, label: event.newName, labelSource: 'user' };
}

