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

/**
 * Issue #87 review, eighth pass, Important finding 1: what to send as
 * `distribute_code` in the project-server save request. For a locked
 * (isolated) server the flag is not actually user-controlled — distribution
 * happens unconditionally regardless of what gets saved — so persisting the
 * form's (possibly display-forced) value would leave a stale opt-in behind
 * once isolation is later turned off. Returning `undefined` here tells the
 * caller to omit the key; the PUT handler's "key absent -> preserve existing
 * value" semantics then keep whatever was actually saved before, instead of
 * silently overwriting it with `true`.
 */
export function resolveDistributeCodeForSave(
  server: DistributeCodePolicyServer | undefined,
  distributeCode: boolean,
): boolean | undefined {
  return isDistributeCodeLocked(server) ? undefined : distributeCode;
}
