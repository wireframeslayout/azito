/**
 * Issue #87 third-party review, seventh pass, Minor finding 3: an isolated
 * server holds no git credentials of its own, so the backend ALWAYS
 * distributes this project's code to it via `isolationIntent` — regardless
 * of the per-project-server `distributeCode` flag a project server row may
 * have saved in an earlier, non-isolated session. `ProjectSettings.tsx`'s
 * distribute-code toggle and the project-server list badge both need to
 * agree with that backend behavior; these pure predicates are the single
 * place that encodes it, so the two call sites (and their tests) can't
 * silently drift apart.
 */

/** The subset of `Server` this policy actually depends on. */
export interface DistributeCodePolicyServer {
  isolationIntent?: boolean;
}

/**
 * Whether the distribute-code toggle for `server` must be locked ON in the
 * UI (disabled, checked) because distribution is not actually optional for
 * it.
 */
export function isDistributeCodeLocked(server: DistributeCodePolicyServer | undefined): boolean {
  return !!server?.isolationIntent;
}

/**
 * Whether the project-server list should show the "distributed" badge for
 * `server` — true when it's actually being distributed, which for an
 * isolated server is unconditional (see `isDistributeCodeLocked`) and for
 * any other server is exactly the saved `distributeCode` flag.
 */
export function shouldShowDistributeCodeBadge(
  server: DistributeCodePolicyServer | undefined,
  distributeCode: boolean | undefined,
): boolean {
  return isDistributeCodeLocked(server) || !!distributeCode;
}
