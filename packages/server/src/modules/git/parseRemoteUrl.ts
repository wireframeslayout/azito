export type RepositoryProvider = 'github' | 'gitlab' | 'other';

export interface ParsedRemote {
  provider: RepositoryProvider;
  owner: string | null;
  repoName: string | null;
  host: string | null;
}

const GITHUB_RE = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const GITLAB_RE = /gitlab[^/]*[/:]([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/;
const GENERIC_HTTPS_RE = /^https?:\/\/([^/]+)\/([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/;
const GENERIC_SSH_PROTO_RE = /^ssh:\/\/[^@]+@([^:/]+)(?::\d+)?\/([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/;
const GENERIC_SCP_RE = /^[^@]+@([^:/]+):([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/;

export function parseRemoteUrl(url: string): ParsedRemote {
  const ghMatch = url.match(GITHUB_RE);
  if (ghMatch) {
    return { provider: 'github', owner: ghMatch[1], repoName: ghMatch[2], host: 'github.com' };
  }

  const glMatch = url.match(GITLAB_RE);
  if (glMatch) {
    const hostMatch = url.match(/(?:@|\/\/)([^:/]+)/);
    return { provider: 'gitlab', owner: glMatch[1], repoName: glMatch[2], host: hostMatch?.[1] ?? null };
  }

  const httpsMatch = url.match(GENERIC_HTTPS_RE);
  if (httpsMatch) {
    return { provider: 'other', owner: httpsMatch[2], repoName: httpsMatch[3], host: httpsMatch[1] };
  }

  const sshProtoMatch = url.match(GENERIC_SSH_PROTO_RE);
  if (sshProtoMatch) {
    return { provider: 'other', owner: sshProtoMatch[2], repoName: sshProtoMatch[3], host: sshProtoMatch[1] };
  }

  const scpMatch = url.match(GENERIC_SCP_RE);
  if (scpMatch) {
    return { provider: 'other', owner: scpMatch[2], repoName: scpMatch[3], host: scpMatch[1] };
  }

  return { provider: 'other', owner: null, repoName: null, host: null };
}

const DEFAULT_PORT_BY_SCHEME: Record<string, string> = {
  https: '443',
  http: '80',
  ssh: '22',
};

/**
 * Normalizes a git remote URL to a comparable identity string, used to
 * detect "is this the same repository" (dedup on discovery, already-
 * registered checks). Deliberately conservative: only syntax known to be
 * equivalent is folded together.
 *
 * - Hostname is lowercased (DNS names are case-insensitive).
 * - The path is NOT lowercased — most git hosting is case-sensitive for the
 *   owner/repo path (`Owner/Repo` and `owner/repo` can be different repos).
 * - A non-default port is preserved (`host:2222/path` is a different
 *   service from `host/path`); a default port for the URL's scheme
 *   (443/https, 80/http, 22/ssh) is dropped since it's equivalent to
 *   omitting it.
 * - A trailing `.git` suffix and trailing slash are stripped (both are
 *   syntactically equivalent forms of the same remote).
 * - The scheme is preserved in the identity for general hosts:
 *   `http://host/repo`, `https://host/repo` and `ssh://host/repo` are
 *   different services on a self-hosted target and must not be treated as
 *   the same repository (Issue #19 third-party review round 2, Important
 *   finding 3 — the previous version dropped the scheme unconditionally,
 *   which could cause a legitimate distinct repository to be reported as
 *   "already registered" and excluded from bulk registration). Cross-
 *   protocol unification (https/ssh pointing at the same repo) is applied
 *   only for hosts that are known to be a single hosting service reachable
 *   over multiple protocols — currently just `github.com` — never as a
 *   general rule.
 *
 * Issue #19 third-party review, Important finding 4: the previous
 * implementation lowercased the entire URL and unconditionally dropped the
 * port, which could equate genuinely distinct repositories (different case
 * paths on a case-sensitive host, or different services on different
 * ports).
 */
const KNOWN_CROSS_PROTOCOL_HOSTS = new Set(['github.com']);

function isKnownCrossProtocolHost(host: string): boolean {
  return KNOWN_CROSS_PROTOCOL_HOSTS.has(host);
}

export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      const host = parsed.hostname.toLowerCase();
      const defaultPort = DEFAULT_PORT_BY_SCHEME[scheme];
      const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : '';
      const path = parsed.pathname
        .replace(/^\/+/, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
      const schemePrefix = isKnownCrossProtocolHost(host) ? '' : `${scheme}://`;
      return `${schemePrefix}${host}${port}/${path}`;
    } catch {
      // Not a valid WHATWG URL despite the scheme prefix — fall through to
      // the scp-like/plain handling below rather than guessing.
    }
  }

  // scp-like syntax: `[user@]host:path` (e.g. `git@github.com:owner/repo.git`).
  // This form is always ssh, so it is folded into the `ssh://` identity for
  // general hosts (so it compares equal to an explicit `ssh://host/path`
  // remote pointing at the same place), while known cross-protocol hosts
  // drop the prefix entirely as above.
  const scpMatch = trimmed.match(/^(?:[a-zA-Z0-9_.-]+@)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(.+)$/);
  if (scpMatch) {
    const [, rawHost, rawPath] = scpMatch;
    const host = rawHost.toLowerCase();
    const path = rawPath.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^\/+/, '');
    const schemePrefix = isKnownCrossProtocolHost(host) ? '' : 'ssh://';
    return `${schemePrefix}${host}/${path}`;
  }

  return trimmed;
}
