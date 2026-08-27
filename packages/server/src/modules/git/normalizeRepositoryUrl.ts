/**
 * Normalizes a project's registered repository URL to a canonical `https://`
 * form. Accepts scp-like (`git@host:owner/repo.git`), `ssh://`, and
 * `https://` inputs. `http:` (plaintext) is rejected — hub-transfer
 * operations (fetch distribution + push notarization, Issue #87) use this URL
 * with `GIT_ASKPASS`-injected credentials, and plaintext would expose the
 * token on the wire.
 *
 * Returns `null` when the input cannot be confidently parsed. Callers MUST
 * treat `null` as "do not proceed" (Fail Fast). This function never throws.
 */
export function normalizeRepositoryUrlToHttps(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Rebuild from the parsed URL to normalize scheme/host casing (WHATWG URL
  // spec lowercases these). Path is reproduced as-given (case-sensitive on
  // some hosts). `http://` is matched to reach the same parser but rejected.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:') return null;
      if (!url.host) return null;
      // Require namespace + repo (>=2 non-empty path segments) or fail closed.
      const segments = url.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length < 2) return null;
      return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`.replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  // ssh://[user@]host[:port]/owner/repo(.git)
  const sshUrlMatch = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)\/?$/i);
  if (sshUrlMatch) {
    const [, host, ownerAndRepo] = sshUrlMatch;
    return buildHttpsUrl(host, ownerAndRepo);
  }

  // Any other explicit scheme (git://, file://, ftp://, …) — never guess at
  // one of these; only the forms handled above are accepted.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

  // scp-like syntax: [user@]host:owner/repo(.git) — git's other native form,
  // and the one most operators actually paste (`git@github.com:owner/repo.git`).
  const scpMatch = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+?)\/?$/);
  if (scpMatch) {
    const [, host, ownerAndRepo] = scpMatch;
    return buildHttpsUrl(host, ownerAndRepo);
  }

  return null;
}

function buildHttpsUrl(host: string, ownerAndRepoPath: string): string | null {
  if (!host || !ownerAndRepoPath) return null;
  const path = ownerAndRepoPath.replace(/\.git$/i, '');
  if (!path) return null;
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  return `https://${host.toLowerCase()}/${path}.git`;
}
