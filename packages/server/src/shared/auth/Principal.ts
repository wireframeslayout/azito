// ─── Principal (claim-shaped authorization) ───
//
// Issue #28 Phase A: every authenticated request resolves to exactly one
// `Principal` before any route handler runs (see buildServer.ts's onRequest
// hook). Routes declare which principal classes/conditions they accept via
// route config metadata (see routeAuth.ts) instead of branching on URL
// prefixes.
//
// Deliberately NOT claim-encoded into the token itself (design v3 §1): a
// tmux pane cannot be handed a fresh signed claim after launch (env is only
// injected at window-creation time), so the token is an opaque capability
// reference and the server resolves its current permissions from
// task_tokens at request time. This keeps revocation (task status
// transition, task deletion) effective immediately, and keeps the door open
// for a future signed-claim token format without touching any route's auth
// declaration.

/**
 * Extension point (design v3 §1 note b): #62 will add a `trigger` class for
 * scheduled/webhook-originated actors, and future agent-to-agent
 * conversation support may add relationship-scoped principals. Adding a
 * class here is additive — existing route declarations that don't list it
 * keep defaulting to operator-only.
 */
export type PrincipalClass = 'operator' | 'task' | 'trigger' | 'runtime' | 'agent';

/**
 * `id` is the class-specific subject identifier (task.id for class='task').
 * Omitted for classes without a meaningful single subject (operator today).
 */
export interface Principal {
  class: PrincipalClass;
  id?: number;
}

export const OPERATOR_PRINCIPAL: Principal = { class: 'operator' };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by buildServer.ts's onRequest auth hook before any route handler runs. */
    principal?: Principal;
  }
}
