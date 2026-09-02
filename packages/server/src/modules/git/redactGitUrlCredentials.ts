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
 *
 * Fail safe on the scheme-less branch (Issue #87 later review round,
 * Important finding): a scheme-less value that is NOT structurally a valid
 * scp-like remote (`[user@]host:path`) is no longer echoed back verbatim.
 * Git only ever emits a `git remote get-url` value shaped like one of the
 * forms `resolveCanonicalRepositoryIdentity` already recognizes
 * (`https://`/`ssh://` etc., or scp-like); anything else reaching this
 * function — a local filesystem path, or arbitrary unparseable text — is not
 * a legitimate remote URL shape at all, so there is no valid parse that
 * could tell credential material apart from the rest of the string. Rather
 * than guess (and risk echoing a token embedded in that unrecognized text,
 * as `?token=...` suffixes on a local path or garbage input previously
 * did), this function returns a fixed placeholder for anything it cannot
 * structurally recognize. Log usefulness is intentionally sacrificed here:
 * a vague log line is a minor annoyance, a leaked credential is not.
 */
export function redactGitUrlCredentials(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '(empty)';

  // scp-like syntax (`[user@]host:owner/repo.git`, e.g.
  // `git@github.com:owner/repo.git`) has no scheme and is NOT a valid
  // WHATWG URL — handle it before `new URL()`, which would either throw or
  // misparse `host:path` as some unrelated scheme-like structure. This
  // syntax carries no password (only a `user@` prefix, conventionally
  // `git`), so stripping that prefix is enough.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // Query string / fragment suffixes are not part of scp-like syntax at
    // all, but some inputs that reach this branch carry one anyway (e.g. a
    // credential smuggled onto a bare `host:path?token=...` or a local
    // path); strip it before validating the structural shape below so a
    // structurally valid scp remote with a bogus suffix is still redacted
    // rather than falling through to the placeholder.
    const suffixIndex = trimmed.search(/[?#]/);
    const core = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);

    // Require the strict `[user@]host:path` shape — a bare hostname-like
    // token, an alnum host, then `:`, then a non-empty path. A local
    // filesystem path (`/local/path`), a bare host with no path, or
    // anything without this shape does NOT match and falls through to the
    // safe placeholder below.
    const scpMatch = core.match(
      /^(?:[a-zA-Z0-9_.-]+@)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(.+)$/
    );
    if (!scpMatch) return '(unrecognized origin url)';
    const [, host, path] = scpMatch;
    return `${host}:${path}`;
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
