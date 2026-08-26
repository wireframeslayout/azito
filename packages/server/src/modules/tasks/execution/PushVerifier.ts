import { execSync } from 'child_process';
import type { TmuxClient } from '../../tmux/TmuxClient';
import type { ServerConfig } from '../../servers/Server';
import type { ProjectRepositoryWithToken as ProjectRepository } from '../../projects/Project';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import { shellQuote } from '../../../shared/shellQuote';

/**
 * Verifies that a push (and, unless skipped, a PR/MR) has actually landed by
 * comparing local/remote SHAs and checking for an open PR/MR via
 * GitProviderService (no CLI dependency — Issue: git provider abstraction).
 */
export class PushVerifier {
  constructor(private tmux: TmuxClient, private gitProvider: GitProviderService) {}

  async verifyPushCompleted(
    server: ServerConfig,
    workingDir: string,
    branch: string,
    skipPr?: boolean,
    repo?: ProjectRepository | null,
  ): Promise<boolean> {
    try {
      const shas = server.type === 'local'
        ? this.readShasLocal(workingDir, branch)
        : await this.readShasRemote(server, workingDir, branch);
      if (!shas) return false;
      const { localSha, remoteSha } = shas;
      if (localSha.slice(0, 40) !== remoteSha.slice(0, 40)) return false;

      if (skipPr) return true;
      // No repository info to check against: skip PR verification and rely on
      // push confirmation alone. Behavior change from the old CLI-based
      // implementation, which could verify a PR without registered repo info
      // (gh/glab inferred the repo from the git remote in the working dir);
      // the API path deliberately does not re-implement that inference — it
      // would be a hidden fallback. Register the repository (owner/repoName)
      // on the AZITO project to re-enable PR verification.
      if (!repo || !repo.owner || !repo.repoName) return true;

      const pr = await this.gitProvider.findPullRequestByBranch(repo, branch);
      return pr !== null;
    } catch {
      return false;
    }
  }

  private readShasLocal(workingDir: string, branch: string): { localSha: string; remoteSha: string } | null {
    const opts = { cwd: workingDir, encoding: 'utf-8' as const, timeout: 5000 };
    try {
      const localSha = execSync('git rev-parse HEAD', opts).trim();
      const remoteShaLine = execSync(`git ls-remote --heads origin ${branch}`, opts).trim();
      if (!localSha || !remoteShaLine) return null;
      return { localSha, remoteSha: remoteShaLine.slice(0, 40) };
    } catch {
      return null;
    }
  }

  private async readShasRemote(server: ServerConfig, workingDir: string, branch: string): Promise<{ localSha: string; remoteSha: string } | null> {
    try {
      // `workingDir` comes from `assertPathContained`'s resolved output and
      // `branch` from task/worktree metadata — neither is restricted to a
      // safe character set anymore (Issue #27 review finding 2 removed the
      // global `assertSafePath` gate from PathContainment), so this call
      // site is now the one responsible for quoting its own shell
      // interpolation, same as every other `cd -- <path>` call in this
      // codebase.
      const quotedDir = shellQuote(workingDir);
      const quotedBranch = shellQuote(branch);
      const r1 = await this.tmux.execCommand(server, `cd -- ${quotedDir} && git rev-parse HEAD`);
      const localSha = r1.stdout.trim();
      const r2 = await this.tmux.execCommand(server, `cd -- ${quotedDir} && git ls-remote --heads origin ${quotedBranch}`);
      const remoteShaLine = r2.stdout.trim();
      if (!localSha || !remoteShaLine) return null;
      return { localSha, remoteSha: remoteShaLine.slice(0, 40) };
    } catch {
      return null;
    }
  }

  async verifyHubPushCompleted(
    repo: ProjectRepository | null,
    branch: string,
    expectedSha: string,
  ): Promise<boolean> {
    if (!repo || !repo.owner || !repo.repoName) return false;
    try {
      const remoteSha = await this.gitProvider.getBranchHeadSha(repo, branch);
      return remoteSha === expectedSha;
    } catch {
      return false;
    }
  }
}
