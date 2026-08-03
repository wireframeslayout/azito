import { api } from '../api/client';

/**
 * Best-effort teardown of a shared-browser instance's Chromium tabs on the server side.
 * Called wherever a browser tab is explicitly closed via × — Workspace-level (see
 * useTabPersistence's closeTab) and task-scoped (TaskPanel's own `v-browser:` tabs) alike —
 * instead of waiting for the keepalive TTL to expire. Not awaited: closing a tab locally
 * must never block on network, and a failure here just means the group survives until its
 * TTL naturally expires rather than being torn down immediately.
 */
export function closeBrowserGroup(serverName: string, pageId: string): void {
  api('/browser/close-group', {
    method: 'POST',
    body: JSON.stringify({ server: serverName, group: pageId }),
  }).catch(() => {});
}
