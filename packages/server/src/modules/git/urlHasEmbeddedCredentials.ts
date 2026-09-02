/**
 * Detects whether a git remote URL carries embedded credentials
 * (`https://user:token@host/repo.git`), so a caller can reject it outright
 * rather than merely redact it for display.
 *
 * This is deliberately separate from `redactGitUrlCredentials` (which
 * always returns a printable, safe-to-log string and never throws): this
 * function answers a yes/no validation question used to refuse writing a
 * credentialed URL into `project_repositories.url` (a plaintext column) —
 * credentials belong only in the existing encrypted `token` column
 * (Issue #19 third-party review, Important finding 1).
 *
 * Only a non-empty password is treated as a credential signal. A bare
 * username is not enough on its own: `ssh://git@host/path` conventionally
 * carries an account name (`git`), not a secret, and flagging it would
 * reject every ordinary SSH remote. `https://token@host/...` (a token used
 * as the username with no password, a pattern some hosts accept) is also
 * treated as a credential, since HTTP(S) has no legitimate non-secret use
 * for a bare username the way SSH does.
 */
export function urlHasEmbeddedCredentials(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // scp-like syntax (`git@host:owner/repo.git`) and anything else without
    // a URL scheme carries no password field to smuggle a credential in.
    return false;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }

  if (url.password) return true;

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if ((scheme === 'http' || scheme === 'https') && url.username) return true;

  return false;
}
