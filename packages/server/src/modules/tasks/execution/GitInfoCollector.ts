import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ServerConfig } from '../../servers/Server';
import { SAFE_BRANCH } from '../../git/GitDiffService';
import { runGit } from '../../git/runGit';

const GIT_INFO_TIMEOUT_MS = 10_000;

function parseNameStatus(diff: string): string | null {
  if (!diff) return null;
  const files = diff.split('\n').filter(l => /^[AMDRC]/.test(l)).map(l => {
    const [status, ...rest] = l.split('\t');
    return { status, file: rest.join('\t') };
  });
  return files.length > 0 ? JSON.stringify(files) : null;
}

export interface GitInfo {
  branch: string | null;
  changedFiles: string | null;
}

/**
 * Collects post-execution git state (current branch, changed files) from a
 * task's working directory, and writes files into the target environment
 * (local/agent) through the host's file operations. git runs as an argv on the
 * host that owns the directory (no shell, so the same on every OS).
 * PR/MR URL lookup is not this module's responsibility — callers resolve it via
 * GitProviderService.findPullRequestByBranch (no CLI dependency).
 */
export class GitInfoCollector {
  constructor(private transportFactory: TransportFactory) {}

  async collectGitInfo(server: ServerConfig, workingDir: string, baseBranch?: string): Promise<GitInfo> {
    const transport = this.transportFactory.getTransport(server);
    const result: GitInfo = { branch: null, changedFiles: null };
    // git's own refusal (not a repository, no parent commit) is a null result, so callers can tell it from empty output.
    // A transport that cannot run git at all (unreachable agent, git missing) is thrown, not turned into an empty result.
    const run = async (args: string[]): Promise<string | null> => {
      const r = await runGit(transport, workingDir, args, { timeoutMs: GIT_INFO_TIMEOUT_MS });
      return r.exitCode === 0 ? r.stdout.trim() : null;
    };

    result.branch = (await run(['branch', '--show-current'])) || null;

    // Distinguish command failure from an empty diff: a successful base...HEAD
    // diff with zero changes is a valid result and must not fall back to HEAD~1.
    let baseDiffSucceeded = false;
    if (baseBranch && SAFE_BRANCH.test(baseBranch)) {
      const baseDiff = await run(['-c', 'core.quotepath=false', 'diff', '--name-status', `${baseBranch}...HEAD`]);
      if (baseDiff !== null) {
        result.changedFiles = parseNameStatus(baseDiff);
        baseDiffSucceeded = true;
      }
    }
    if (!baseDiffSucceeded) {
      const diff = await run(['-c', 'core.quotepath=false', 'diff', '--name-status', 'HEAD~1']);
      if (diff !== null) result.changedFiles = parseNameStatus(diff);
    }

    return result;
  }

  /**
   * Write a text file into the target environment (local/agent) through the host's own file operations (UTF-8, no shell,
   * so arbitrary multi-line text and any path notation transfer as they are). The directory must already exist.
   */
  async writeRemoteFile(server: ServerConfig, filePath: string, content: string): Promise<void> {
    await this.transportFactory.getFileOps(server).write(filePath, Buffer.from(content, 'utf-8'));
  }
}
