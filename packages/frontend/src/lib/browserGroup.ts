import { api } from '../api/client';

/**
 * Best-effort teardown of a shared-browser instance's Chromium tabs on the server side.
 * Called wherever a browser tab is explicitly closed via × — Workspace-level (see
 * useTabPersistence's closeTab) and task-scoped (TaskPanel's own `v-browser:` tabs) alike —
 * instead of waiting for the keepalive TTL to expire. Closing a tab locally must never block
 * on this network call, so callers should not await it before finishing the local close —
 * but the returned promise always resolves (never rejects, even on failure) once the
 * teardown attempt settles, so callers that need to react afterward (e.g. refreshing the
 * browser-groups list only once the server actually knows the group is gone) can chain off
 * it without blocking the close itself.
 */
export function closeBrowserGroup(serverName: string, pageId: string): Promise<void> {
  return api('/browser/close-group', {
    method: 'POST',
    body: JSON.stringify({ server: serverName, group: pageId }),
  }).then(
    () => undefined,
    () => undefined,
  );
}
