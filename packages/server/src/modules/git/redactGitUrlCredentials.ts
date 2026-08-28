/**
 * Strips credentials (and any other userinfo) out of a git remote URL
 * before it is ever placed in a log line or an error message.
 *
 * Why this exists: `git remote get-url origin` on a `workingDir` can return
 * literally whatever a human or another tool set as `origin` — including a
 * URL with embedded credentials (`https://user:token@host/repo.git`, a
 * common way to configure git push/fetch auth outside this codebase's own
 * `GIT_ASKPASS` flow). `FetchDistributionService.verifyUnstampedIdentity`
 * surfaces that raw origin value in both a warning log and a thrown error
 * message when it can't confirm a pre-existing `workingDir`'s identity —
 * and both of those reach a task's execution log, which is visible to
 * whoever can see the task. A raw origin URL must never be embedded in
 * either (Issue #87 third-party review, 12th round, Important finding 1).
 *
 * This is deliberately a standalone pure function (not inlined at the call
 * site) so it can be exercised against every URL shape git accepts —
 * `https://`/`ssh://` with and without embedded credentials, and the
 * scp-like `user@host:path` syntax — independent of `FetchDistributionService`.
 *
 * Never throws, and always returns a printable string — including for
 * inputs this codebase's own `normalizeRepositoryUrlToHttps` rejects (an
 * unparseable value, or a scheme it doesn't recognize) — so a caller can
 * log the result unconditionally, with no second guard needed.
 *
 * Also strips the query string and fragment (Issue #87 15th-round review,
 * Important finding 1): a normalized URL's `toString()` preserves both, and
 * some hosting providers accept a token in the query string (e.g.
 * `?token=...`) rather than as userinfo — leaving those in place would
 * defeat the redaction this function exists to provide.
 */
export function redactGitUrlCredentials(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '(empty)';

  // scp-like syntax (`[user@]host:owner/repo.git`, e.g.
  // `git@github.com:owner/repo.git`) has no scheme and is NOT a valid
  // WHATWG URL — handle it before `new URL()`, which would either throw or
  // misparse `host:path` as some unrelated scheme-like structure. This
  // syntax carries no password (only a `user@` prefix, conventionally
  // `git`), so stripping that prefix is enough. It also has no query
  // string or fragment syntax to worry about.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpMatch = trimmed.match(/^[^@/]+@(.+)$/);
    return scpMatch ? scpMatch[1] : trimmed;
  }

  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // Has a scheme prefix but does not parse as a URL — do not fall through
    // to logging the raw value; garbage following a `scheme://` prefix
    // could still itself be `user:token@...` that `URL` simply choked on.
    return '(unparseable origin url)';
  }
}
