import type { Server } from '../hooks/useServerManagement';

/**
 * The answer of `GET /servers` as the server list, or an Error carrying why it is not one. `api()` hands back the body of an HTTP
 * 500 / 502 as if it were a success, so the list is checked here: anything but an OK array is a failed fetch, never a stored list.
 */
export function serverListFrom(res: { status: number; body: unknown }): Server[] {
  if (res.status >= 200 && res.status < 300 && Array.isArray(res.body)) return res.body as Server[];
  const reason = res.body && typeof res.body === 'object' && typeof (res.body as { error?: unknown }).error === 'string'
    ? (res.body as { error: string }).error
    : null;
  throw new Error(reason ? `HTTP ${res.status}: ${reason}` : `HTTP ${res.status}`);
}

/** Whether a failed fetch is newer than the last successful one (an older request that fails late must not undo a newer success). */
export function isFailureNewerThanSuccess(failedSeq: number, activeSeq: number): boolean {
  return failedSeq > activeSeq;
}

export type FileTabServersView = 'server-gone' | 'servers-unavailable' | 'loading' | 'file';

/**
 * What a restored file tab shows. `serversLoaded` is whether this page load has fetched `/servers` (the cached copy, when there is
 * one, is not that), `serversError` why the latest fetch failed, `settled` whether the tab's key can no longer change
 * (`isFileTabSettled`), `serverGone` whether the loaded list lacks the tab's server.
 */
export function fileTabServersView(state: { serversLoaded: boolean; serversError: string | null; settled: boolean; serverGone: boolean }): FileTabServersView {
  if (state.serverGone) return 'server-gone';
  if (state.settled) return 'file';
  return state.serversError !== null && !state.serversLoaded ? 'servers-unavailable' : 'loading';
}

/** One manual retry: `retrying` is true while it runs and false again however it ends (a failure is kept by the provider as `serversError`). */
export async function retryServersFetch(refresh: () => Promise<unknown>, setRetrying: (retrying: boolean) => void): Promise<void> {
  setRetrying(true);
  try {
    await refresh();
  } catch {
    // Shown through `serversError`.
  } finally {
    setRetrying(false);
  }
}
