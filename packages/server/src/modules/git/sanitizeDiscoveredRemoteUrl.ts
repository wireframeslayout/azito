import { urlHasEmbeddedCredentials } from './urlHasEmbeddedCredentials';

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
 * - SSH SCP-like (`git@host:owner/repo.git`) and `ssh://` URLs: returned
 *   unchanged. The `user@` portion is a conventional account name (`git`,
 *   `forge`, ...), not a secret — `urlHasEmbeddedCredentials` never flags
 *   these (SSH URLs have no password field), so there is nothing to strip.
 * - Local/relative paths, or anything else `urlHasEmbeddedCredentials`
 *   does not recognize as carrying real credential material: returned
 *   unchanged.
 * - HTTP(S) URLs that DO carry embedded credentials
 *   (`https://user:token@host/x.git` or `https://token@host/x.git`): the
 *   userinfo is stripped, yielding a clone-able credential-less URL
 *   (`https://host/x.git`). Query string and fragment are left untouched —
 *   unlike `redactGitUrlCredentials`, this function's contract is "keep it
 *   a working clone URL," and an arbitrary query string is not itself
 *   credential material (`urlHasEmbeddedCredentials` doesn't inspect it).
 */
export function sanitizeDiscoveredRemoteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!urlHasEmbeddedCredentials(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // urlHasEmbeddedCredentials() already confirmed this parses as a URL
    // with a password or an http(s) username, so this branch is
    // unreachable in practice; keep it fail-safe rather than throwing.
    return trimmed;
  }
}
