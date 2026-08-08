import type { Principal } from './Principal';
import { parseTaskTokenHeader } from './taskTokenFormat';

/** Minimal shape resolvePrincipal needs — satisfied by ITaskTokenRepository without importing modules/ from shared/. */
export interface TaskTokenVerifier {
  verify(taskId: number, secret: string): boolean;
}

/**
 * Resolves the single `request.principal` every route sees (Issue #28
 * design v3 §1). A task-token-shaped Authorization header is checked
 * against task_tokens and, if valid, wins outright — it never falls through
 * to the UI token check (a malformed/revoked task token must fail closed,
 * not silently degrade into "maybe this was a UI token").
 */
export function resolvePrincipal(
  authHeader: string | undefined,
  deps: { verifyUiToken: (authHeader: string | undefined) => boolean; taskTokenRepo: TaskTokenVerifier },
): Principal | null {
  const taskToken = parseTaskTokenHeader(authHeader);
  if (taskToken) {
    return deps.taskTokenRepo.verify(taskToken.taskId, taskToken.secret) ? { class: 'task', id: taskToken.taskId } : null;
  }
  return deps.verifyUiToken(authHeader) ? { class: 'operator' } : null;
}
