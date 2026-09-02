import type { ProjectRepository } from '../projects/Project';
import { normalizeRepositoryUrlToHttps } from './normalizeRepositoryUrl';

/**
 * One resolved repository identity — the SAME provider/host/owner/repo every
 * hub-transfer (fetch distribution / push notarization), PR, and verification
 * call site must agree on (Issue #87).
 */
export interface CanonicalRepositoryIdentity {
  provider: 'github' | 'gitlab';
  host: string;
  owner: string;
  repo: string;
  /** Canonical `https://<host>/<owner>/<repo>.git` form — see {@link normalizeRepositoryUrlToHttps}. */
  httpsUrl: string;
}

export type RepositoryIdentityResult =
  | { ok: true; identity: CanonicalRepositoryIdentity }
  | { ok: false; reason: 'url_not_normalizable' | 'identity_mismatch' };

/**
 * Resolves ONE canonical repository identity for a project repository row,
 * cross-checking the independently-editable `url`, `provider`, `owner`, and
 * `repoName` fields against each other (Issue #87, ported from #29 Step 3b).
 *
 * Normalizes `url` to `https://` via {@link normalizeRepositoryUrlToHttps}
 * and derives `owner`/`repo` from the URL path. When the row's own fields
 * are present, they MUST agree (case-insensitively); disagreement fails
 * closed as `identity_mismatch`.
 *
 * GitLab subgroups: LAST path segment = repo, everything before = owner.
 * GitHub: exactly 2 segments required.
 *
 * Callers MUST treat `ok: false` as "do not proceed" (Fail Fast).
 */
export function resolveCanonicalRepositoryIdentity(
  repo: Pick<ProjectRepository, 'url' | 'provider' | 'owner' | 'repoName'>,
): RepositoryIdentityResult {
  const httpsUrl = normalizeRepositoryUrlToHttps(repo.url);
  if (!httpsUrl) return { ok: false, reason: 'url_not_normalizable' };

  let parsed: URL;
  try {
    parsed = new URL(httpsUrl);
  } catch {
    return { ok: false, reason: 'url_not_normalizable' };
  }

  // Provider is resolved from the repository row itself (never guessed from
  // the host), same as the `provider` value returned below — a self-managed
  // GitLab/GHE instance would not otherwise be distinguishable by host alone.
  const provider: 'github' | 'gitlab' = repo.provider === 'gitlab' ? 'gitlab' : 'github';

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  let urlOwner: string | undefined;
  let urlRepo: string | undefined;
  if (provider === 'gitlab') {
    // Subgroups: everything but the last segment is the namespace.
    if (segments.length >= 2) {
      urlRepo = segments[segments.length - 1]?.replace(/\.git$/i, '');
      urlOwner = segments.slice(0, -1).join('/');
    }
  } else {
    // GitHub: owner/repo is always exactly 2 segments — no subgroups.
    if (segments.length === 2) {
      urlOwner = segments[0];
      urlRepo = segments[1]?.replace(/\.git$/i, '');
    }
  }
  if (!urlOwner || !urlRepo) return { ok: false, reason: 'url_not_normalizable' };

  if (repo.owner && repo.owner.toLowerCase() !== urlOwner.toLowerCase()) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (repo.repoName && repo.repoName.toLowerCase() !== urlRepo.toLowerCase()) {
    return { ok: false, reason: 'identity_mismatch' };
  }

  return {
    ok: true,
    identity: {
      provider,
      host: parsed.host,
      owner: repo.owner || urlOwner,
      repo: repo.repoName || urlRepo,
      httpsUrl,
    },
  };
}
