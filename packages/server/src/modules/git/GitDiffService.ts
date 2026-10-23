import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { parseUnifiedDiff, unquoteGitPath, type FileDiff } from './DiffParser';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';
import { shellQuote } from '../../shared/shellQuote';
import type { CommandResult } from '../../shared/exec/commandSpec';
import { runGit, combinedOutput } from './runGit';

import { SAFE_PATH_PATTERN, SAFE_BRANCH_PATTERN, assertNotOptionLike } from './assertSafeGitArgs';
export { SAFE_PATH_PATTERN as SAFE_PATH, SAFE_BRANCH_PATTERN as SAFE_BRANCH };
export const SAFE_HASH = /^[0-9a-f]{7,40}$/;

const MAX_DIFF_SIZE = 1_000_000;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_FILE_SIZE = 100_000;

export type DiffScope = 'uncommitted' | 'base' | 'commit';

export interface GitDiffResult {
  baseBranch: string;
  headBranch: string;
  files: FileDiff[];
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GetDiffOptions {
  scope?: DiffScope;
  includeUncommitted?: boolean;
}

/** Throws with git's own message (or the exit code when it said nothing) when a git command exited non-zero. */
function assertGitSucceeded(result: CommandResult, what: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed: ${combinedOutput(result) || `exit ${result.exitCode}`}`);
  }
}

/** The checked-out branch name from `rev-parse --abbrev-ref HEAD`; 'HEAD' when git cannot say (detached, no commits). */
function headBranchOf(result: CommandResult): string {
  return result.exitCode === 0 ? stripTerminalArtifacts(result.stdout).trim() || 'HEAD' : 'HEAD';
}

export class GitDiffService {
  constructor(private readonly transportFactory: TransportFactory) {}

  async getCommits(srv: ServerConfig, dirPath: string, base?: string): Promise<GitCommit[]> {
    if (base && !SAFE_BRANCH_PATTERN.test(base)) throw new Error(`Invalid base branch: ${base}`);
    if (base) assertNotOptionLike(base, 'base branch');
    const transport = this.transportFactory.getTransport(srv);

    const range = base ? [`${base}..HEAD`] : ['-50', 'HEAD'];
    const FIELD_SEP = '<<>>';
    const RECORD_SEP = '<<||>>';
    const fmt = `%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`;
    const result = await runGit(transport, undefined, ['-c', 'core.quotepath=false', '-C', dirPath, 'log', `--pretty=format:${fmt}`, ...range]);
    assertGitSucceeded(result, 'git log');

    const raw = stripTerminalArtifacts(result.stdout);
    return raw
      .split(RECORD_SEP)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(FIELD_SEP);
        const [hash, shortHash, author, date] = parts;
        const subject = parts.slice(4).join(FIELD_SEP);
        return { hash, shortHash, author, date, subject };
      });
  }

  async getDiff(srv: ServerConfig, dirPath: string, base: string, commit?: string, options?: GetDiffOptions): Promise<GitDiffResult> {
    const scope = options?.scope;

    if (scope === 'uncommitted') {
      return this.getUncommittedDiff(srv, dirPath);
    }

    if (scope === 'base') {
      const includeUncommitted = options?.includeUncommitted !== false;
      return this.getBaseDiff(srv, dirPath, base, includeUncommitted);
    }

    if (scope === 'commit') {
      if (!commit) throw new Error('commit hash is required for commit scope');
      return this.getCommitDiff(srv, dirPath, commit);
    }

    // Backward-compatible: no scope specified
    if (commit) {
      return this.getCommitDiff(srv, dirPath, commit);
    }

    return this.getLegacyDiff(srv, dirPath, base);
  }

  private async getCommitDiff(srv: ServerConfig, dirPath: string, commit: string): Promise<GitDiffResult> {
    if (!SAFE_HASH.test(commit)) throw new Error(`Invalid commit hash: ${commit}`);
    const transport = this.transportFactory.getTransport(srv);

    const diffResult = await runGit(transport, undefined, ['-c', 'core.quotepath=false', '-C', dirPath, 'show', '--format=', '--unified=3', commit]);
    assertGitSucceeded(diffResult, 'git diff');

    const rawDiff = stripTerminalArtifacts(diffResult.stdout);
    const { files, truncated } = this.parseDiffWithTruncation(rawDiff);
    return { baseBranch: `${commit}^`, headBranch: commit.slice(0, 7), files, truncated };
  }

  private async getLegacyDiff(srv: ServerConfig, dirPath: string, base: string): Promise<GitDiffResult> {
    if (base && !SAFE_BRANCH_PATTERN.test(base)) throw new Error(`Invalid base branch: ${base}`);
    if (base) assertNotOptionLike(base, 'base branch');
    const transport = this.transportFactory.getTransport(srv);

    const headResult = await runGit(transport, undefined, ['-C', dirPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const headBranch = headBranchOf(headResult);

    const diffRef = base ? `${base}...HEAD` : 'HEAD';
    const diffResult = await runGit(transport, undefined, ['-c', 'core.quotepath=false', '-C', dirPath, 'diff', '--unified=3', diffRef]);
    assertGitSucceeded(diffResult, 'git diff');

    const rawDiff = stripTerminalArtifacts(diffResult.stdout);
    const { files, truncated } = this.parseDiffWithTruncation(rawDiff);
    return { baseBranch: base || 'HEAD', headBranch, files, truncated };
  }

  private async getUncommittedDiff(srv: ServerConfig, dirPath: string): Promise<GitDiffResult> {
    const transport = this.transportFactory.getTransport(srv);
    const gitInDir = (...args: string[]): ReturnType<typeof runGit> =>
      runGit(transport, undefined, ['-c', 'core.quotepath=false', '-C', dirPath, ...args]);

    // Run all commands in parallel
    const [stagedNamesResult, unstagedNamesResult, diffResult, statusResult, headResult] = await Promise.all([
      gitInDir('diff', '--cached', '--name-only'),
      gitInDir('diff', '--name-only'),
      gitInDir('diff', '--unified=3', 'HEAD'),
      gitInDir('status', '--porcelain', '-uall'),
      runGit(transport, undefined, ['-C', dirPath, 'rev-parse', '--abbrev-ref', 'HEAD']),
    ]);

    const headBranch = headBranchOf(headResult);

    // Parse staged/unstaged name sets
    const stagedNames = new Set(
      stripTerminalArtifacts(stagedNamesResult.stdout).trim().split('\n').filter(Boolean),
    );
    const unstagedNames = new Set(
      stripTerminalArtifacts(unstagedNamesResult.stdout).trim().split('\n').filter(Boolean),
    );

    // Parse the combined diff
    assertGitSucceeded(diffResult, 'git diff');

    const rawDiff = stripTerminalArtifacts(diffResult.stdout);
    let { files, truncated } = this.parseDiffWithTruncation(rawDiff);

    // Assign groups to tracked files
    files = files.map((f) => {
      let group: 'staged' | 'unstaged';
      if (unstagedNames.has(f.file)) {
        group = 'unstaged';
      } else if (stagedNames.has(f.file)) {
        group = 'staged';
      } else {
        group = 'unstaged';
      }
      return { ...f, group };
    });

    // Parse untracked files from porcelain status
    const statusOutput = stripTerminalArtifacts(statusResult.stdout);
    const untrackedPaths: string[] = [];
    for (const line of statusOutput.split('\n')) {
      if (line.startsWith('?? ')) {
        const raw = line.slice(3).replace(/\/$/, '');
        untrackedPaths.push(unquoteGitPath(raw));
      }
    }

    // Synthesize diffs for untracked files (with limits)
    if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
      truncated = true;
    }

    const pathsToProcess = untrackedPaths.slice(0, MAX_UNTRACKED_FILES);
    const untrackedResults: (FileDiff | null)[] = [];
    for (const filePath of pathsToProcess) {
      untrackedResults.push(await this.synthesizeUntrackedDiff(transport, dirPath, filePath));
    }

    for (const uf of untrackedResults) {
      if (uf) files.push(uf);
      else truncated = true;
    }

    // Sort: staged first, then unstaged, then untracked
    const groupOrder = { staged: 0, unstaged: 1, untracked: 2 };
    files.sort((a, b) => (groupOrder[a.group ?? 'unstaged'] ?? 1) - (groupOrder[b.group ?? 'unstaged'] ?? 1));

    return { baseBranch: 'HEAD', headBranch, files, truncated };
  }

  private async synthesizeUntrackedDiff(
    transport: ReturnType<TransportFactory['getTransport']>,
    dirPath: string,
    filePath: string,
  ): Promise<FileDiff | null> {
    const safeDir = shellQuote(dirPath);
    const safePath = shellQuote(filePath);

    // Check file size and binary status
    const statResult = await transport.exec(
      `cd ${safeDir} && wc -c < ${safePath} 2>/dev/null`,
    );
    const fileSize = parseInt(stripTerminalArtifacts(statResult.stdout).trim(), 10);
    if (isNaN(fileSize) || fileSize > MAX_UNTRACKED_FILE_SIZE) {
      return fileSize > MAX_UNTRACKED_FILE_SIZE
        ? { file: filePath, status: 'A', additions: 0, deletions: 0, hunks: [], isBinary: false, group: 'untracked' }
        : null;
    }

    // Check if binary (NUL byte in first 8KB)
    const headResult = await transport.exec(
      `cd ${safeDir} && head -c 8192 ${safePath} | tr -cd '\\0' | wc -c`,
    );
    const nulCount = parseInt(stripTerminalArtifacts(headResult.stdout).trim(), 10);
    if (nulCount > 0) {
      return { file: filePath, status: 'A', additions: 0, deletions: 0, hunks: [], isBinary: true, group: 'untracked' };
    }

    // Read file content and synthesize diff
    const catResult = await transport.exec(`cd ${safeDir} && cat ${safePath}`);
    const content = stripTerminalArtifacts(catResult.stdout);
    const lines = content.split('\n');
    // Remove trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const diffLines = lines.map((line, i) => ({
      type: 'add' as const,
      content: line,
      oldLine: null,
      newLine: i + 1,
    }));

    return {
      file: filePath,
      status: 'A',
      additions: diffLines.length,
      deletions: 0,
      hunks: diffLines.length > 0
        ? [{
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: diffLines.length,
            header: `@@ -0,0 +1,${diffLines.length} @@`,
            lines: diffLines,
          }]
        : [],
      isBinary: false,
      group: 'untracked',
    };
  }

  private async getBaseDiff(srv: ServerConfig, dirPath: string, base: string, includeUncommitted: boolean): Promise<GitDiffResult> {
    if (!base) throw new Error('base branch is required for base scope');
    if (!SAFE_BRANCH_PATTERN.test(base)) throw new Error(`Invalid base branch: ${base}`);
    assertNotOptionLike(base, 'base branch');
    const transport = this.transportFactory.getTransport(srv);

    const headResult = await runGit(transport, undefined, ['-C', dirPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const headBranch = headBranchOf(headResult);

    let diffRef: string;
    if (includeUncommitted) {
      // Resolve merge-base and diff against working tree
      const mergeBaseResult = await runGit(transport, undefined, ['-C', dirPath, 'merge-base', base, 'HEAD']);
      assertGitSucceeded(mergeBaseResult, 'git merge-base');
      diffRef = stripTerminalArtifacts(mergeBaseResult.stdout).trim();
    } else {
      diffRef = `${base}...HEAD`;
    }

    const diffResult = await runGit(transport, undefined, ['-c', 'core.quotepath=false', '-C', dirPath, 'diff', '--unified=3', diffRef]);
    assertGitSucceeded(diffResult, 'git diff');

    const rawDiff = stripTerminalArtifacts(diffResult.stdout);
    const { files, truncated } = this.parseDiffWithTruncation(rawDiff);
    return { baseBranch: base, headBranch, files, truncated };
  }

  private parseDiffWithTruncation(rawDiff: string): { files: FileDiff[]; truncated: boolean } {
    let truncated = false;
    let files = parseUnifiedDiff(rawDiff);

    if (rawDiff.length > MAX_DIFF_SIZE) {
      truncated = true;
      files = files.map((f) => {
        const totalLines = f.hunks.reduce((sum, h) => sum + h.lines.length, 0);
        if (totalLines > 500) {
          return { ...f, hunks: f.hunks.slice(0, 3) };
        }
        return f;
      });
    }

    return { files, truncated };
  }
}
