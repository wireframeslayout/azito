import type { TmuxClient } from '../tmux/TmuxClient';
import type { ServerConfig } from '../servers/Server';
import { parseRemoteUrl, type ParsedRemote } from './parseRemoteUrl';

export interface DiscoveredRemote {
  name: string;
  url: string;
  parsed: ParsedRemote;
}

export interface DiscoveredRepo {
  relativePath: string;
  absolutePath: string;
  remotes: DiscoveredRemote[];
}

function escapeShellSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export class RepoDiscoveryService {
  constructor(private tmux: TmuxClient) {}

  async discover(server: ServerConfig, workingDirectory: string, depth = 3): Promise<DiscoveredRepo[]> {
    const safeDir = escapeShellSingleQuote(workingDirectory);
    const findCmd = `find '${safeDir}' -maxdepth ${depth + 1} -type d -name .git -not -path '*/node_modules/*' -not -path '*/.*/*' 2>/dev/null || true`;
    const findResult = await this.tmux.execCommand(server, findCmd);

    const gitDirs = findResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.endsWith('/.git') && !/[\x00-\x1f]/.test(l));

    if (gitDirs.length === 0) return [];

    const repoDirs = gitDirs.map((d) => d.replace(/\/\.git$/, ''));
    const batchCmd = repoDirs
      .map((d) => {
        const safe = escapeShellSingleQuote(d);
        return `echo '---REPO_SEPARATOR:${safe}' && git -C '${safe}' remote -v 2>/dev/null || true`;
      })
      .join(' && ');

    let batchResult;
    try {
      batchResult = await this.tmux.execCommand(server, batchCmd);
    } catch {
      return repoDirs.map((d) => ({ relativePath: relativize(workingDirectory, d), absolutePath: d, remotes: [] }));
    }

    return parseBatchRemoteOutput(batchResult.stdout, workingDirectory);
  }
}

function relativize(base: string, full: string): string {
  const normalizedBase = base.endsWith('/') ? base : base + '/';
  if (full.startsWith(normalizedBase)) {
    return full.slice(normalizedBase.length) || '.';
  }
  return full;
}

function parseBatchRemoteOutput(stdout: string, workingDirectory: string): DiscoveredRepo[] {
  const repos: DiscoveredRepo[] = [];
  let currentDir: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentDir !== null) {
      repos.push({
        relativePath: relativize(workingDirectory, currentDir),
        absolutePath: currentDir,
        remotes: parseRemoteLines(currentLines),
      });
    }
  };

  for (const line of stdout.split('\n')) {
    const sep = line.match(/^---REPO_SEPARATOR:(.+)$/);
    if (sep) {
      flush();
      currentDir = sep[1];
      currentLines = [];
    } else if (currentDir !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return repos;
}

function parseRemoteLines(lines: string[]): DiscoveredRemote[] {
  const seen = new Map<string, DiscoveredRemote>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
    if (!match) continue;
    const [, name, url] = match;
    if (seen.has(name)) continue;
    seen.set(name, { name, url, parsed: parseRemoteUrl(url) });
  }
  const entries = [...seen.values()];
  entries.sort((a, b) => {
    if (a.name === 'origin') return -1;
    if (b.name === 'origin') return 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

