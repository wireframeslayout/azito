import { randomUUID } from 'node:crypto';
import type { BrowserSessionManager } from './BrowserSessionManager';

export interface OpenBrowserTabParams {
  url?: string;
  holdSeconds?: number;
  hubOrigin?: string;
}

export interface OpenBrowserTabResult {
  groupId: string;
  tabId: string;
  targetId: string | null;
  cdpEndpoint: string;
}

export async function openBrowserTab(
  browserSessionManager: BrowserSessionManager,
  serverName: string,
  params: OpenBrowserTabParams,
): Promise<OpenBrowserTabResult> {
  const session = await browserSessionManager.getOrCreate(serverName, {
    hubOrigin: params.hubOrigin,
  });
  const groupId = `agent-${randomUUID().slice(0, 8)}`;
  const tabId = 't1';
  const page = await session.getOrCreatePage(groupId, tabId);

  if (params.holdSeconds != null) {
    const clamped = Math.max(0, Math.min(Number(params.holdSeconds) || 0, 3600));
    if (clamped > 0) {
      session.setGroupHold(groupId, Date.now() + clamped * 1000);
    }
  }

  if (params.url && typeof params.url === 'string') {
    await page.dispatchInput({ type: 'navigate', url: params.url });
  }

  return {
    groupId,
    tabId,
    targetId: page.targetId,
    cdpEndpoint: 'http://127.0.0.1:9222',
  };
}
