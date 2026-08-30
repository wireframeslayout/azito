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
 * Username policy (why only `ssh://`/SCP keep it, and every other scheme
 * drops it):
 * - For `ssh://` and SCP-like (`user@host:path`) syntax, the username is
 *   the *connection account* (`git`, `forge`, ...), which git needs to
 *   even attempt the connection and which is not itself a credential —
 *   authentication happens via the SSH key, not the username. So it is
 *   kept. Only an explicit `user:password@host` form (uncommon, but valid
 *   SCP-like syntax) carries an actual secret in that slot, and only the
 *   password portion of it is stripped.
 * - For every other scheme — `http(s)://` and any non-SSH `scheme://`
 *   alike (`git://`, `ftp://`, `file://`, ...) — the "username" slot is
 *   routinely abused to carry a bearer token or PAT
 *   (`https://ghp_xxx@github.com/...`, `git://token@example.com/...`) —
 *   i.e. it is frequently itself the secret, so it is always dropped,
 *   along with the password slot. Restricting the keep-list to `ssh://`
 *   only (instead of "any scheme that isn't http(s)") closes a gap where
 *   `git://`/`ftp://` username credentials were passed through unchanged
 *   (Issue #87 review round, Important finding: "ssh://`/`git://` etc. →
 *   keep username" was too broad — only `ssh://` username is actually
 *   safe to keep).
 *
 * Behavior by input shape:
 * - SSH SCP-like (`git@host:owner/repo.git`) syntax: has no URL scheme at
 *   all (git parses the `host:path` form itself). The `user@` prefix is
 *   kept unchanged (see username policy above). If the prefix is instead
 *   `user:password@host:...`, the password portion is stripped, leaving
 *   `user@host:...` — there is no query/fragment concept in this syntax to
 *   carry a credential either.
 * - Local absolute paths (`/srv/repos/x.git`) and relative paths
 *   (`../x.git`): also have no URL scheme, so they fall into the same
 *   "return unchanged" bucket as SCP-like syntax above (minus any
 *   `user[:pass]@` prefix, which they don't have).
 * - `ssh://` URLs: username is kept (see policy above), but password,
 *   query string, and fragment are all stripped — git ignores
 *   query/fragment on this scheme, and either can smuggle a credential
 *   (`ssh://host/repo.git?x=secret`) just as easily as userinfo can.
 * - `http://` / `https://` URLs, and any other non-SSH `scheme://` URL
 *   (`git://`, `ftp://`, `file://`, ...) that parses successfully:
 *   userinfo (username AND password), the query string, and the fragment
 *   are ALL stripped unconditionally — regardless of whether
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
 *   parse as a URL (structurally malformed): returns `null`. It cannot be
 *   inspected or cleaned and may still carry credential material, so it
 *   must not be passed through unchanged — but it must also not be
 *   replaced with a fixed placeholder string, because a placeholder is
 *   still a value: callers were storing it into `project_repositories.url`
 *   and reporting the repository as "added", and two unrelated unparseable
 *   inputs would collide on the same placeholder and be treated as
 *   duplicates of each other (Issue #19 3rd review round, Nit finding 2).
 *   Callers must treat `null` as "this remote/URL is unusable" and drop it
 *   rather than substitute a display string.
 */
const SCP_LIKE_SSH = /^([^@\s/]+)@([^:\s]+):(?!\/\/)/;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

export function sanitizeDiscoveredRemoteUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();

  const scpMatch = SCP_LIKE_SSH.exec(trimmed);
  if (scpMatch) {
    const userinfo = scpMatch[1];
    const colonIndex = userinfo.indexOf(':');
    if (colonIndex === -1) return trimmed; // plain `user@host:path`, nothing to strip
    // `user:password@host:path` — keep the account name, drop the password.
    const username = userinfo.slice(0, colonIndex);
    return username + trimmed.slice(userinfo.length);
  }

  const schemeMatch = URL_SCHEME.exec(trimmed);
  if (!schemeMatch) {
    // No recognizable URL scheme and not SCP-like syntax: a local
    // absolute path or a relative path. Neither has a userinfo, query, or
    // fragment field for git to smuggle a credential into.
    return trimmed;
  }

  const scheme = schemeMatch[1].toLowerCase();

  try {
    const url = new URL(trimmed);
    if (scheme !== 'ssh') {
      // Only `ssh://` username is the non-secret connection account (`git`,
      // `forge`, ...) — see policy note above. Every other scheme
      // (`http(s)://`, `git://`, `ftp://`, `file://`, ...) routinely uses
      // the username slot as a token carrier, so it is always dropped.
      url.username = '';
    }
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // Had a `scheme://` prefix but is not a structurally valid URL — we
    // cannot inspect or clean it, so refuse to pass it through unchanged
    // or substitute a placeholder. Callers must drop this entry.
    return null;
  }
}
