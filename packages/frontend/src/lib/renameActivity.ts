import { isSameWindowTarget } from '@azito/shared';
import type { WindowRenamedPayload } from '../types/notification';

type ActivityIdentity = { serverName: string; target: string; windowId?: number };

export function matchesRename(entry: ActivityIdentity, event: WindowRenamedPayload): boolean {
  return event.windowId == null && entry.windowId == null && entry.serverName === event.serverName && isSameWindowTarget(entry.target, event.target);
}

export function renameActivity<T extends ActivityIdentity & { label?: string; labelSource?: 'auto' | 'user' }>(entry: T, event: WindowRenamedPayload): T {
  if (!matchesRename(entry, event) || (entry.label === event.newName && entry.labelSource === 'user')) return entry;
  return { ...entry, label: event.newName, labelSource: 'user' };
}

