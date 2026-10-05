import { errorMessageOf } from './apiResult';

export type TaskMutationFailure =
  | { kind: 'mux_driver_unavailable' }
  | { kind: 'error'; message: string };

/**
 * Judges the answer to a task delete / archive request. `apiWithStatus` resolves for any HTTP status, so a
 * failed mutation must be recognised here: null means it succeeded. The hub answers 503 `mux_driver_unavailable`
 * when the task's window cannot be closed because its mux daemon is down — nothing was changed in that case.
 */
export function taskMutationFailure(status: number, body: unknown): TaskMutationFailure | null {
  if (status >= 200 && status < 300) return null;
  if (typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'mux_driver_unavailable') {
    return { kind: 'mux_driver_unavailable' };
  }
  return { kind: 'error', message: errorMessageOf(body) ?? `HTTP ${status}` };
}
