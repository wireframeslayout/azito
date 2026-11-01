import { isSameWindowTarget } from '@azito/shared';
import { activityKey } from './finishedWindows';
import { parseTerminalTabId, refTabMatchesTarget } from './terminalRef';

export function isWatchedWindow(
  browserFocused: boolean, activeTabId: string | null, focusedTarget: string | null,
  serverName: string, target: string, windowId?: number,
): boolean {
  if (!browserFocused) return false;
  const parsed = activeTabId ? parseTerminalTabId(activeTabId) : null;
  if (parsed && parsed.serverName === serverName) {
    if (parsed.kind === 'windowId' && windowId != null && parsed.windowId === windowId) return true;
    if (parsed.kind === 'legacy' && isSameWindowTarget(parsed.target, target)) return true;
    if (parsed.kind === 'ref' && refTabMatchesTarget(parsed.ref, target)) return true;
  }
  return focusedTarget === activityKey(serverName, target, windowId)
    || focusedTarget === activityKey(serverName, target);
}
