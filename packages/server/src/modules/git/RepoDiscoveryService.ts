import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import { parseRemoteUrl, normalizeRemoteUrl, type ParsedRemote, type RepositoryProvider } from './parseRemoteUrl';
import { shellQuote } from '../../shared/shellQuote';
import { CommandSpawnError, type CommandResult } from '../../shared/exec/commandSpec';
import { runGit } from './runGit';
import { sanitizeDiscoveredRemoteUrl } from './sanitizeDiscoveredRemoteUrl';

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

export interface DiscoveredRepoRemoteResponse {
  name: string;
  url: string;
  provider: RepositoryProvider;
  owner: string | null;
  repoName: string | null;
  alreadyRegistered: boolean;
}

export interface DiscoveredRepoResponse {
  relativePath: string;
  absolutePath: string;
  remotes: DiscoveredRepoRemoteResponse[];
}

/**
 * Shared response shaping between the project-scoped discovery endpoint
 * (`GET /api/projects/:id/servers/:serverName/discover-repositories`) and
 * the project-independent one (`GET /api/servers/:name/discover-repositories`,
 * usable before a project exists). Both must apply the same credential
 * stripping (`sanitizeDiscoveredRemoteUrl`) and drop remotes it cannot
 * clean rather than showing a placeholder — this function is the single
 * place that logic lives, so neither route can drift from the other.
 *
 * `existingUrls` is a set of already-registered remote URLs (normalized via
 * `normalizeRemoteUrl`) used to compute `alreadyRegistered`. The
 * project-independent caller has no project to check against, so it passes
 * an empty set — every remote comes back `alreadyRegistered: false` there,
 * which is simply true (there is nothing yet to be "already registered"
 * with), not a stand-in for unknown/unchecked state.
 */
export function toDiscoveryResponse(repos: DiscoveredRepo[], existingUrls: Set<string>): DiscoveredRepoResponse[] {
  return repos.map((repo) => ({
    relativePath: repo.relativePath,
    absolutePath: repo.absolutePath,
    remotes: repo.remotes
      .map((remote) => {
        const safeUrl = sanitizeDiscoveredRemoteUrl(remote.url);
        if (safeUrl === null) return null;
        return {
          name: remote.name,
          url: safeUrl,
          provider: remote.parsed.provider,
          owner: remote.parsed.owner,
          repoName: remote.parsed.repoName,
          alreadyRegistered: existingUrls.has(normalizeRemoteUrl(safeUrl)),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
  }));
}

export interface PathStatus {
  exists: boolean;
  isGitRepository: boolean;
}

/** How many candidate repositories are inspected at once (each is two short git commands). */
const CANDIDATE_CONCURRENCY = 8;

export class RepoDiscoveryService {
  constructor(private transportFactory: TransportFactory) {}

  /**
   * Reports whether `path` exists on `server`, and if so whether `path`
   * itself (not a descendant) is a git repository root — used by the
   * project-independent discovery endpoint so the create-project wizard
   * can distinguish "this path will be created" (does not exist yet, not
   * an error) from "this path is already a git repo" without running a
   * full recursive scan first. A `.git` entry can be a directory (normal
   * clone) or a file (worktree/submodule pointer), matching the same
   * candidate shape `discover()` accepts.
   */
  async checkPathStatus(server: ServerConfig, path: string): Promise<PathStatus> {
    const safePath = shellQuote(path);
    const cmd = `if [ -e ${safePath} ]; then echo EXISTS; if [ -e ${safePath}/.git ]; then echo ISGIT; fi; fi`;
    const result = await this.transportFactory.getTransport(server).exec(cmd);
    if (result.code !== 0) {
      throw new Error(`Path status check failed for '${path}' (exit code ${result.code})`);
    }
    const lines = result.stdout.split('\n').map((l) => l.trim());
    return {
      exists: lines.includes('EXISTS'),
      isGitRepository: lines.includes('ISGIT'),
    };
  }

  /**
   * Scans `workingDirectory` for git repositories and their remotes.
   *
   * Both real transport failures and command-level failures are propagated
   * as thrown errors rather than converted into an empty/success result —
   * a scan that could not actually run must never be reported the same way
   * as a scan that genuinely found nothing (Issue #19 third-party review,
   * Important finding 5).
   */
  async discover(server: ServerConfig, workingDirectory: string, depth = 3): Promise<DiscoveredRepo[]> {
    const safeDir = shellQuote(workingDirectory);
    // `.git` can be a directory (a normal clone) or a file (a worktree, or
    // most submodules — it holds a `gitdir: <path>` pointer instead).
    // Restricting to `-type d` silently excluded both (Important finding 3).
    //
    // Excluding ALL hidden directories (`-not -path '*/.*/*'`) also
    // silently excluded every worktree, because AZITO itself creates task
    // worktrees under a hidden `.worktrees/` directory — e.g.
    // `.worktrees/task-1/.git` never matched, defeating the -type f fix
    // above for the exact case it exists to catch (Issue #19 later review
    // round, Important finding). The exclusion is narrowed to what
    // actually should not be scanned: `node_modules`, and the *contents*
    // of an already-found `.git` directory (its internals, e.g.
    // `.git/modules/**`, are not themselves repositories to report, and
    // descending into them would just add noise/duplicates) — the `.git`
    // entry itself is still matched by `-name .git`; only paths inside it
    // (its internals) are excluded.
    const findCmd = `find ${safeDir} -maxdepth ${depth + 1} \\( -type d -o -type f \\) -name .git -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`;
    const transport = this.transportFactory.getTransport(server);
    // The scan itself is a shell `find` (a file operation), so it stays on exec until IFileOps (#379 P7).
    const findResult = await transport.exec(findCmd);
    if (findResult.code !== 0) {
      throw new Error(`Repository scan failed while searching '${workingDirectory}' (exit code ${findResult.code})`);
    }

    const candidateDirs = findResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.endsWith('/.git') && !/[\x00-\x1f]/.test(l))
      .map((l) => l.replace(/\/\.git$/, ''));

    if (candidateDirs.length === 0) return [];

    // `git` itself must be runnable before any candidate is inspected: with it missing, every candidate would look like a
    // broken repository and be dropped, and the scan would report "nothing found" instead of failing. This is an
    // unconditional, command-level failure of the whole scan.
    const gitUnusable = (detail: string): Error =>
      new Error(`Repository remote lookup failed: 'git' is not usable on '${workingDirectory}' (${detail})`);
    let gitCheckResult: CommandResult;
    try {
      gitCheckResult = await runGit(transport, undefined, ['--version']);
    } catch (err) {
      if (err instanceof CommandSpawnError) throw gitUnusable(err.message);
      throw err;
    }
    if (gitCheckResult.exitCode !== 0) throw gitUnusable(`exit code ${gitCheckResult.exitCode}`);

    // Resolve each candidate to its actual repository root via `git rev-parse --show-toplevel` (this is what correctly
    // turns a worktree's `.git` *file* location into that worktree's own root, rather than the main checkout's), then fetch
    // its remotes.
    //
    // A broken/unreadable candidate (its `rev-parse` exits non-zero) is dropped and every other candidate is still
    // returned, wherever it sits in `find`'s (filesystem-dependent) order. `git` being unusable at all was handled above;
    // a failure to run the command (transport, timeout) is thrown, never turned into an empty result.
    const inspected = await mapWithConcurrency(candidateDirs, CANDIDATE_CONCURRENCY, async (dir) => {
      const toplevel = await runGit(transport, undefined, ['-C', dir, 'rev-parse', '--show-toplevel']);
      if (toplevel.exitCode !== 0) return null;
      const remotes = await runGit(transport, undefined, ['-C', dir, 'remote', '-v']);
      return { toplevel: toplevel.stdout, remoteLines: remotes.exitCode === 0 ? remotes.stdout.split('\n') : [] };
    });

    return dedupeByAbsolutePath(toDiscoveredRepos(inspected, workingDirectory));
  }
}

function relativize(base: string, full: string): string {
  const normalizedBase = base.endsWith('/') ? base : base + '/';
  if (full.startsWith(normalizedBase)) {
    return full.slice(normalizedBase.length) || '.';
  }
  return full;
}

function dedupeByAbsolutePath(repos: DiscoveredRepo[]): DiscoveredRepo[] {
  const byPath = new Map<string, DiscoveredRepo>();
  for (const repo of repos) {
    if (!byPath.has(repo.absolutePath)) {
      byPath.set(repo.absolutePath, repo);
    }
  }
  return [...byPath.values()];
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the results in the order of `items`. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toDiscoveredRepos(inspected: Array<{ toplevel: string; remoteLines: string[] } | null>, workingDirectory: string): DiscoveredRepo[] {
  const repos: DiscoveredRepo[] = [];
  for (const candidate of inspected) {
    if (!candidate) continue;
    const absolutePath = candidate.toplevel.split('\n')[0].trim();
    if (!absolutePath || !absolutePath.startsWith('/')) continue; // rev-parse printed nothing usable for this candidate
    repos.push({
      relativePath: relativize(workingDirectory, absolutePath),
      absolutePath,
      remotes: parseRemoteLines(candidate.remoteLines),
    });
  }
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
