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

export function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim();
  // ssh://git@host:port/path → host/path
  normalized = normalized.replace(/^ssh:\/\/[^@]*@/, '');
  // https://host/path → host/path
  normalized = normalized.replace(/^https?:\/\//, '');
  // git@host:path → host/path
  normalized = normalized.replace(/^[^@]+@([^:]+):/, '$1/');
  // remove trailing .git
  normalized = normalized.replace(/\.git$/, '');
  // remove trailing slash
  normalized = normalized.replace(/\/+$/, '');
  // remove port from ssh:// urls (host:port/path → host/path)
  normalized = normalized.replace(/^([^/]+):\d+\//, '$1/');
  return normalized.toLowerCase();
}
