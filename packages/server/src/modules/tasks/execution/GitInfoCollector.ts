import { execSync } from 'child_process';
import type { TmuxClient } from '../../tmux/TmuxClient';
import type { ServerConfig } from '../../servers/Server';
import { SAFE_BRANCH } from '../../git/GitDiffService';
import { assertSafePath } from '../../git/assertSafeGitArgs';

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
 * (local/agent) via the transport shell. PR/MR URL lookup is not this
 * module's responsibility — callers resolve it via
 * GitProviderService.findPullRequestByBranch (no CLI dependency).
 */
export class GitInfoCollector {
  constructor(private tmux: TmuxClient) {}

  collectGitInfoSync(workingDir: string, baseBranch?: string): GitInfo {
    const result: GitInfo = { branch: null, changedFiles: null };
    const opts = { cwd: workingDir, encoding: 'utf-8' as const, timeout: 5000 };

    try {
      result.branch = execSync('git branch --show-current', opts).trim() || null;
    } catch {}

    // Distinguish command failure from an empty diff: a successful base...HEAD
    // diff with zero changes is a valid result and must not fall back to HEAD~1.
    let baseDiffSucceeded = false;
    if (baseBranch && SAFE_BRANCH.test(baseBranch)) {
      try {
        result.changedFiles = parseNameStatus(execSync(`git -c core.quotepath=false diff --name-status ${baseBranch}...HEAD`, opts).trim());
        baseDiffSucceeded = true;
      } catch {}
    }
    if (!baseDiffSucceeded) {
      try {
        result.changedFiles = parseNameStatus(execSync('git -c core.quotepath=false diff --name-status HEAD~1', opts).trim());
      } catch {}
    }

    return result;
  }

  async collectGitInfoRemote(server: ServerConfig, workingDir: string, baseBranch?: string): Promise<GitInfo> {
    assertSafePath(workingDir, 'workingDir');
    const result: GitInfo = { branch: null, changedFiles: null };
    // Returns null on failure so callers can distinguish it from empty output.
    // SSH transports always report code 0, so git errors are detected in stdout/stderr.
    const run = async (cmd: string): Promise<string | null> => {
      try {
        const safeDir = workingDir.replace(/'/g, "'\\''");
        const r = await this.tmux.execCommand(server, `cd '${safeDir}' && ${cmd}`);
        if (r.code !== 0 || /^fatal:|^error:/m.test(`${r.stdout}\n${r.stderr}`)) return null;
        return r.stdout.trim();
      } catch { return null; }
    };

    result.branch = (await run('git branch --show-current')) || null;

    // Distinguish command failure from an empty diff: a successful base...HEAD
    // diff with zero changes is a valid result and must not fall back to HEAD~1.
    let baseDiffSucceeded = false;
    if (baseBranch && SAFE_BRANCH.test(baseBranch)) {
      const baseDiff = await run(`git -c core.quotepath=false diff --name-status ${baseBranch}...HEAD`);
      if (baseDiff !== null) {
        result.changedFiles = parseNameStatus(baseDiff);
        baseDiffSucceeded = true;
      }
    }
    if (!baseDiffSucceeded) {
      const diff = await run('git -c core.quotepath=false diff --name-status HEAD~1');
      if (diff !== null) result.changedFiles = parseNameStatus(diff);
    }

    return result;
  }

  /**
   * Write a text file into the target environment (local/agent) via the
   * transport shell. Content is base64-encoded so arbitrary multi-line text
   * (rules, markdown) transfers safely without shell-quoting concerns.
   */
  async writeRemoteFile(server: ServerConfig, filePath: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    // base64 alphabet contains no single quotes, so single-quoting is safe.
    const command = `echo '${b64}' | base64 -d > '${filePath}'`;
    const result = await this.tmux.execCommand(server, command);
    if (result.code !== 0) {
      throw new Error(`Failed to write file ${filePath}: ${result.stderr || `exit ${result.code}`}`);
    }
  }
}
