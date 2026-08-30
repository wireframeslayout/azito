import type { TmuxClient } from '../tmux/TmuxClient';
import type { ServerConfig } from '../servers/Server';
import { parseRemoteUrl, type ParsedRemote } from './parseRemoteUrl';
import { shellQuote } from '../../shared/shellQuote';

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

const SECTION_MARKER = '---AZITO_REPO_SECTION---';

export class RepoDiscoveryService {
  constructor(private tmux: TmuxClient) {}

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
    const findResult = await this.tmux.execCommand(server, findCmd);
    if (findResult.code !== 0) {
      throw new Error(`Repository scan failed while searching '${workingDirectory}' (exit code ${findResult.code})`);
    }

    const candidateDirs = findResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.endsWith('/.git') && !/[\x00-\x1f]/.test(l))
      .map((l) => l.replace(/\/\.git$/, ''));

    if (candidateDirs.length === 0) return [];

    // Resolve each candidate to its actual repository root via
    // `git rev-parse --show-toplevel` (this is what correctly turns a
    // worktree's `.git` *file* location into that worktree's own root,
    // rather than the main checkout's), then fetch its remotes. Both run
    // in the same batched command to avoid one round-trip per candidate.
    const batchCmd = candidateDirs
      .map((d) => {
        const safe = shellQuote(d);
        return `echo '${SECTION_MARKER}' && (git -C ${safe} rev-parse --show-toplevel 2>/dev/null; git -C ${safe} remote -v 2>/dev/null)`;
      })
      .join(' ; ');

    const batchResult = await this.tmux.execCommand(server, batchCmd);
    // A nonzero exit here reflects only the trailing `git remote -v` (the
    // last command in the chain), which already tolerates failure per
    // repository via its own `2>/dev/null` — a broken/unreadable repo
    // simply resolves with no remotes rather than failing the whole scan.

    return dedupeByAbsolutePath(parseBatchOutput(batchResult.stdout, workingDirectory));
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

function parseBatchOutput(stdout: string, workingDirectory: string): DiscoveredRepo[] {
  const repos: DiscoveredRepo[] = [];
  let sectionLines: string[] = [];

  const flush = () => {
    if (sectionLines.length === 0) return;
    const absolutePath = sectionLines[0].trim();
    if (!absolutePath || !absolutePath.startsWith('/')) return; // rev-parse failed for this candidate
    repos.push({
      relativePath: relativize(workingDirectory, absolutePath),
      absolutePath,
      remotes: parseRemoteLines(sectionLines.slice(1)),
    });
  };

  for (const line of stdout.split('\n')) {
    if (line === SECTION_MARKER) {
      flush();
      sectionLines = [];
    } else {
      sectionLines.push(line);
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
