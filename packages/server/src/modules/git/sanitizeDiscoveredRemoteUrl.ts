/**
 * Sanitizes a git remote URL discovered on disk (`git remote -v` output) so
 * it can be safely shown to the user and, if they add it, written into the
 * plaintext `project_repositories.url` column — while still remaining a
 * URL that `git clone`/`git fetch` can actually use.
 *
 * This is deliberately NOT `redactGitUrlCredentials`: that function exists
 * for LOG lines and unconditionally strips all userinfo (including the
 * conventional `git` SSH user, which is not a secret), and replaces
 * anything it can't structurally parse with a fixed placeholder string —
 * both of which are fine for a log line but corrupt a URL meant to be
 * stored and later cloned from (Issue #19 review round, Important
 * finding 1: reusing `redactGitUrlCredentials` here turned
 * `git@github.com:owner/repo.git` into `github.com:owner/repo.git`, a
 * value `git clone` can no longer authenticate with, and turned an
 * unparseable/local-path remote into the literal string
 * `(unrecognized origin url)`).
 *
 * Behavior:
 * - SSH SCP-like (`git@host:owner/repo.git`) syntax: has no URL scheme at
 *   all (git parses the `host:path` form itself), so it is returned
 *   unchanged. The `user@` portion is a conventional account name (`git`,
 *   `forge`, ...), not a secret, and there is no query/fragment concept in
 *   this syntax to carry one either.
 * - Local absolute paths (`/srv/repos/x.git`) and relative paths
 *   (`../x.git`): also have no URL scheme, so they fall into the same
 *   "return unchanged" bucket as SCP-like syntax above — distinguished
 *   from it only by the absence of a leading `user@host:` prefix, which
 *   doesn't matter for how they're handled.
 * - `ssh://` URLs: the userinfo is a conventional account name, not a
 *   secret, and git ignores any query/fragment on an ssh URL. Returned
 *   unchanged.
 * - Any other URL with a recognized `scheme://` prefix (`http://`,
 *   `https://`, `git://`, `ftp://`, `file://`, ...) that parses
 *   successfully: userinfo (username/password), the query string, AND the
 *   fragment are ALL stripped unconditionally — regardless of whether
 *   `urlHasEmbeddedCredentials()` flags this specific URL as carrying a
 *   credential. A clone URL never needs a query string or fragment, and
 *   credentials can be smuggled into either
 *   (`https://host/repo.git?token=secret`,
 *   `https://host/repo.git#access_token=secret`) just as easily as into
 *   userinfo — so this function no longer gates its cleanup on
 *   `urlHasEmbeddedCredentials()` (Issue #19 later review round, Important
 *   finding 1: a userinfo-only check let query/fragment credentials pass
 *   through untouched into the discovery response and the plaintext
 *   `project_repositories.url` column).
 * - A value that has a recognized `scheme://` prefix but still fails to
 *   parse as a URL (structurally malformed): treated conservatively, NOT
 *   returned as-is, since it cannot be inspected or cleaned and may still
 *   carry credential material. This is different from the local/relative
 *   path case above, which is recognized by the ABSENCE of a scheme, not
 *   by a failed parse.
 */
const SCP_LIKE_SSH = /^[^@\s/]+@[^:\s]+:(?!\/\/)/;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const UNPARSEABLE_URL_PLACEHOLDER = '(unparseable remote url redacted)';

export function sanitizeDiscoveredRemoteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();

  if (SCP_LIKE_SSH.test(trimmed)) return trimmed;

  const schemeMatch = URL_SCHEME.exec(trimmed);
  if (!schemeMatch) {
    // No recognizable URL scheme and not SCP-like syntax: a local
    // absolute path or a relative path. Neither has a userinfo, query, or
    // fragment field for git to smuggle a credential into.
    return trimmed;
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'ssh') return trimmed;

  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // Had a `scheme://` prefix but is not a structurally valid URL — we
    // cannot inspect or clean it, so refuse to pass it through unchanged.
    return UNPARSEABLE_URL_PLACEHOLDER;
  }
}
