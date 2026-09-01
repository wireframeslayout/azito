import type { ProjectRepositoryWithToken } from '../../projects/Project';
import { resolveCanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import { getCliToken } from '../providers/cliToken';

/**
 * Which credential hub代行 push notarization authenticated with (Issue #87).
 * Mirrors `DistributionCredentialSource` on the fetch side deliberately: the
 * two directions apply the SAME two-stage resolution documented in
 * `docs/ja/github-integration.md` (1. the repository's stored PAT, 2. the
 * hub operator's `gh`/`glab` CLI token), and an operator reading an
 * execution log must be able to tell them apart the same way in both.
 */
export type PushCredentialSource = 'repository' | 'cli';

export interface ResolvedPushCredential {
  /** Resolved, non-empty token — never logged, never surfaced outside this process. */
  token: string;
  /**
   * WHERE {@link token} came from. Logged (the value never is) because the
   * two are not equivalent in durability: a `cli` credential is ambient hub
   * operator environment and vanishes on `gh auth logout` without any AZITO
   * configuration changing, so "why did this task push yesterday and skip
   * today" is only answerable from the log if the source was recorded.
   */
  source: PushCredentialSource;
}

/**
 * THE single place hub代行 push notarization decides which credential to
 * push with (Issue #87). `PushNotaryService` deliberately does NOT read
 * `repo.token` itself: resolution happens once, at the call site that also
 * owns the "no credential at all" verdict, so the two stages can never be
 * applied in one place and skipped in another.
 *
 * Stage 1 is the repository's own PAT; stage 2 is the hub's `gh`/`glab`
 * token for the repository's canonical host — the same host
 * `resolveCanonicalRepositoryIdentity` gives the fetch side, so both
 * directions ask the CLI about exactly the same host.
 *
 * Returns `null` when BOTH stages come up empty — the caller reports that as
 * an explicit `no_push_credential` skip; it is never hidden behind a
 * fallback. A repository whose URL does not normalize to a canonical
 * identity also returns `null` when it has no PAT: there is no host to ask
 * the CLI about. (With a PAT it never reaches that branch, and
 * `PushNotaryService` still hard-fails on the unresolvable identity, exactly
 * as before this resolver existed.)
 *
 * Asynchronous on purpose — this runs inside the phase loop, which is async
 * throughout; `getCliTokenSync` would block the event loop for the CLI's
 * timeout.
 */
export async function resolvePushCredential(
  repo: Pick<ProjectRepositoryWithToken, 'token' | 'url' | 'provider' | 'owner' | 'repoName'>,
): Promise<ResolvedPushCredential | null> {
  if (repo.token) return { token: repo.token, source: 'repository' };

  const identity = resolveCanonicalRepositoryIdentity(repo);
  if (!identity.ok) return null;

  const token = await getCliToken({ provider: identity.identity.provider, host: identity.identity.host });
  return token ? { token, source: 'cli' } : null;
}
