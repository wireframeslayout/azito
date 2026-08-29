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

/** The subset of a project-server row this policy actually depends on. */
export interface DistributeCodeToggleProjectServer {
  serverName: string;
  distributeCode?: boolean;
}

/**
 * Derives the distribute-code toggle's initial/re-derived value for
 * `serverName` — extracted as a pure function (Issue #87 third-party
 * review, 10th round, Minor finding 3) so `ProjectSettings.tsx`'s
 * `useEffect` can depend on `projectServers` directly instead of reading it
 * out of a stale closure. Before this fix, that effect intentionally
 * excluded `projectServers` from its dependency array (to avoid clobbering
 * an in-progress edit whenever the list happened to refetch); the actual
 * cost of that exclusion was that opening the form BEFORE the project's
 * `project_servers` GET resolved computed this off an empty list — `false`
 * — and never got a chance to correct itself once the real rows arrived,
 * because nothing re-ran once `projectServers` updated out from under it. A
 * save made in that window silently overwrote an existing
 * `distribute_code: true` row with `false`. `false` for `local` (or any
 * server whose type is not being distributed to) mirrors the same
 * short-circuit `ProjectSettings.tsx` already applied inline.
 */
export function resolveDistributeCodeToggleValue(
  targetServerType: string | undefined,
  projectServers: DistributeCodeToggleProjectServer[],
  serverName: string,
): boolean {
  if (targetServerType === 'local') return false;
  const existing = projectServers.find((ps) => ps.serverName === serverName);
  return existing?.distributeCode ?? false;
}

/**
 * Guards `resolveDistributeCodeToggleValue`'s re-derivation against
 * clobbering an in-progress user edit (Issue #87 third-party review, 11th
 * round, Minor finding 3). `ProjectSettings.tsx`'s effect re-runs this
 * whenever `projectServers` changes — which includes a late-arriving
 * response to the initial fetch, but ALSO any later refetch triggered by an
 * unrelated save/remove while this form is still open. Once the user has
 * touched the toggle by hand since the form was (re)opened for the current
 * server (`touched`), any such re-run must return the user's own
 * `currentValue` unchanged rather than overwrite it with whatever the
 * fetched rows now say — the user's own most recent choice always wins over
 * a server response, no matter when that response happens to land.
 * `touched` resets to `false` only when the form is (re)opened for a
 * server (`handleOpenServerForm`), which is also where every other field in
 * this form gets freshly initialized from `projectServers`.
 */
export function resolveDistributeCodeToggleOnProjectServersChange(
  currentValue: boolean,
  touched: boolean,
  targetServerType: string | undefined,
  projectServers: DistributeCodeToggleProjectServer[],
  serverName: string,
): boolean {
  if (touched) return currentValue;
  return resolveDistributeCodeToggleValue(targetServerType, projectServers, serverName);
}

/** The subset of a `Repository` this policy actually depends on. */
export interface DistributionRepositoryPolicyRepo {
  id: number;
}

/**
 * Issue #87 review (Minor finding): whether `distributionRepositoryId` (the
 * form's selected value, `''` when unset) is actually usable — i.e. it names
 * a repository that still exists in `repositories`. Presence of a non-empty
 * string used to be treated as "selected" on its own, but a repository can
 * be deleted (`handleRemoveRepo`) while the project-server form is open with
 * it selected: the DB row's `distribution_repository_id` foreign key is set
 * to NULL (`ON DELETE SET NULL`), yet the form's local
 * `psDistributionRepositoryId` state and the stale `projectServers` list it
 * was seeded from keep the deleted id around, letting the user Save with an
 * id the server will reject (400). Checking membership in the live
 * `repositories` list (not just non-emptiness) is what the caller must
 * gate both the inline validation error and Save's `disabled` state on.
 */
export function isDistributionRepositorySelected(
  repositories: DistributionRepositoryPolicyRepo[] | undefined,
  distributionRepositoryId: string,
): boolean {
  if (!distributionRepositoryId) return false;
  return (repositories ?? []).some((r) => String(r.id) === distributionRepositoryId);
}

/** The subset of a project-server row `resolveDistributionRepositoryIdToggleValue` depends on. */
export interface DistributionRepositoryIdToggleProjectServer {
  serverName: string;
  distributionRepositoryId?: number | null;
}

/**
 * Issue #87 review (Minor finding): the distribution-target-repository
 * `<select>` sits right next to the distribute-code toggle in
 * `ProjectSettings.tsx` and shares the exact same "opened before
 * `projectServers` resolved" hazard `resolveDistributeCodeToggleValue` was
 * introduced for — but it was never given the same fix. Derives the form's
 * `psDistributionRepositoryId` string value (`''` when unset, matching
 * `FormSelect`'s string-only contract) from the live `projectServers` list
 * for `serverName`, so the caller's effect can depend on `projectServers`
 * directly instead of only reading it once at form-open time.
 */
export function resolveDistributionRepositoryIdToggleValue(
  projectServers: DistributionRepositoryIdToggleProjectServer[],
  serverName: string,
): string {
  const existing = projectServers.find((ps) => ps.serverName === serverName);
  return existing?.distributionRepositoryId != null ? String(existing.distributionRepositoryId) : '';
}

/**
 * Guards `resolveDistributionRepositoryIdToggleValue`'s re-derivation
 * against clobbering an in-progress user edit — the same
 * touched-wins-over-late-response rule
 * `resolveDistributeCodeToggleOnProjectServersChange` already applies to the
 * neighboring distribute-code toggle (see its doc comment). `touched` resets
 * to `false` only when the form is (re)opened for a server
 * (`handleOpenServerForm`), same as every other field in that form.
 */
export function resolveDistributionRepositoryIdOnProjectServersChange(
  currentValue: string,
  touched: boolean,
  projectServers: DistributionRepositoryIdToggleProjectServer[],
  serverName: string,
): string {
  if (touched) return currentValue;
  return resolveDistributionRepositoryIdToggleValue(projectServers, serverName);
}
