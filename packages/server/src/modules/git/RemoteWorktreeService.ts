import type { IWorktreeService, WorktreeInfo, WorktreeEntry } from './IWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';

import { hostPathFor } from '@azito/shared';
import { FileOpsError } from '../../shared/fs/fileOps';
import { assertSafeBranch, assertNotOptionLike, assertGitPathArg } from './assertSafeGitArgs';
import { resolveGitPath } from './gitPath';
import { parseWorktreePorcelain } from './parseWorktreePorcelain';
import { combinedOutput, runGit } from './runGit';

export class RemoteWorktreeService implements IWorktreeService {
  constructor(private transport: IServerTransport) {}

  async list(workingDir: string): Promise<WorktreeEntry[]> {
    const platform = this.transport.files().platform;
    assertGitPathArg(platform, workingDir, 'workingDir');
    const result = await runGit(this.transport, await this.absolute(workingDir), ['worktree', 'list', '--porcelain']);
    if (result.exitCode !== 0) {
      if (combinedOutput(result).includes('not a git repository')) {
        return [];
      }
      throw new Error(`Failed to list worktrees: ${result.stderr || result.stdout}`);
    }
    return parseWorktreePorcelain(result.stdout, platform);
  }

  async create(workingDir: string, taskId: number, taskSlug: string, baseBranch: string, branchName?: string): Promise<WorktreeInfo> {
    const platform = this.transport.files().platform;
    assertGitPathArg(platform, workingDir, 'workingDir');
    assertSafeBranch(taskSlug, 'taskSlug');
    assertSafeBranch(baseBranch, 'baseBranch');
    assertNotOptionLike(baseBranch, 'baseBranch');
    if (branchName) {
      assertSafeBranch(branchName, 'branchName');
      assertNotOptionLike(branchName, 'branchName');
    }

    const dir = await this.realDirectory(workingDir);
    const branch = branchName || `task/${taskId}-${taskSlug}`;
    const api = hostPathFor(platform);
    const worktreesDir = api.join(dir, '.worktrees');
    const worktreePath = api.join(worktreesDir, `task-${taskId}`);
    assertNotOptionLike(worktreePath, 'worktreePath');

    await this.transport.files().create(worktreesDir, 'directory', { recursive: true });

    if ((await this.transport.files().stat(worktreePath))?.kind === 'directory') {
      const removed = await runGit(this.transport, dir, ['worktree', 'remove', worktreePath, '--force']);
      if (removed.exitCode !== 0) {
        await runGit(this.transport, dir, ['worktree', 'prune']);
        try { await this.transport.files().remove(worktreePath); } catch {}
      }
    }

    if (branchName) {
      const localCheck = await runGit(this.transport, dir, ['rev-parse', '--verify', branch]);
      let branchExists = localCheck.exitCode === 0;
      if (!branchExists) {
        const remoteCheck = await runGit(this.transport, dir, ['rev-parse', '--verify', `origin/${branch}`]);
        branchExists = remoteCheck.exitCode === 0;
      }

      if (branchExists) {
        const addExisting = ['worktree', 'add', worktreePath, branch];
        const result = await runGit(this.transport, dir, addExisting);
        if (result.exitCode !== 0) {
          const combined = combinedOutput(result);
          if (combined.includes('already used by worktree')) {
            await runGit(this.transport, dir, ['worktree', 'prune']);
            const retry = await runGit(this.transport, dir, addExisting);
            if (retry.exitCode !== 0) {
              const forceRetry = await runGit(this.transport, dir, ['worktree', 'add', '--force', worktreePath, branch]);
              this.assertWorktreeSuccess(forceRetry);
            }
          } else {
            throw new Error(`git worktree add failed: ${combined}`);
          }
        }
      } else {
        const result = await runGit(this.transport, dir, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
        this.assertWorktreeSuccess(result);
      }
    } else {
      // The auto-generated branch is always recreated: one left from an earlier run is dropped first (it usually does not exist).
      await runGit(this.transport, dir, ['branch', '-D', branch]);
      const result = await runGit(this.transport, dir, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
      this.assertWorktreeSuccess(result);
    }

    const verified = await this.exists(worktreePath);
    if (!verified) {
      throw new Error(`Worktree directory not found after creation: ${worktreePath}`);
    }

    return { path: worktreePath, branch };
  }

  async exists(worktreePath: string): Promise<boolean> {
    assertGitPathArg(this.transport.files().platform, worktreePath, 'worktreePath');
    try {
      return (await this.transport.files().stat(await this.absolute(worktreePath)))?.kind === 'directory';
    } catch {
      return false;
    }
  }

  async remove(workingDir: string, worktreePath: string): Promise<void> {
    const platform = this.transport.files().platform;
    assertGitPathArg(platform, workingDir, 'workingDir');
    assertGitPathArg(platform, worktreePath, 'worktreePath');
    const dir = await this.realDirectory(workingDir);
    // The target itself is resolved by the host and that path is what git is given (never a prefix joined onto the resolved
    // directory: `link/..` makes the two differ). One that is already gone cannot be resolved; `prune` settles its registration,
    // and nothing is removed on the strength of how the path is spelled.
    let target: string | null = null;
    try {
      target = await this.transport.files().realpath(worktreePath);
    } catch (err) {
      if (!(err instanceof FileOpsError && err.code === 'NOT_FOUND')) throw err;
    }
    if (target !== null) {
      assertGitPathArg(platform, target, 'resolved path');
      // Best-effort: `remove` fails for a worktree git no longer knows, and `prune` then settles the registry.
      await runGit(this.transport, dir, ['worktree', 'remove', target, '--force']);
    }
    await runGit(this.transport, dir, ['worktree', 'prune']);
  }

  async getBranch(worktreePath: string): Promise<string | null> {
    assertGitPathArg(this.transport.files().platform, worktreePath, 'worktreePath');
    try {
      const result = await runGit(this.transport, undefined, ['-C', await this.absolute(worktreePath), 'branch', '--show-current']);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<string | null> {
    assertGitPathArg(this.transport.files().platform, worktreePath, 'worktreePath');
    assertSafeBranch(baseBranch, 'baseBranch');
    assertNotOptionLike(baseBranch, 'baseBranch');
    const worktree = await this.absolute(worktreePath);
    const nameStatus = async (revision: string): Promise<string | null> => {
      const result = await runGit(this.transport, undefined, ['-c', 'core.quotepath=false', '-C', worktree, 'diff', '--name-status', revision]);
      if (result.exitCode !== 0) throw new Error(`git diff failed: ${combinedOutput(result)}`);
      const diff = result.stdout.trim();
      if (!diff) return null;
      const files = diff.split('\n').filter(l => /^[AMDRC]/.test(l)).map(l => {
        const [status, ...rest] = l.split('\t');
        return { status, file: rest.join('\t') };
      });
      return files.length > 0 ? JSON.stringify(files) : null;
    };
    try {
      return await nameStatus(`${baseBranch}...HEAD`);
    } catch {
      try {
        return await nameStatus('HEAD~1');
      } catch {
        return null;
      }
    }
  }

  /**
   * The working directory as the host's file system sees it: `~` expanded and symbolic links followed. A path is never
   * normalised lexically (`link/../repo` is not `./repo` when `link` is a symbolic link), so git's cwd and every child path
   * (`.worktrees/task-N`) are built from this one value.
   */
  private async realDirectory(workingDir: string): Promise<string> {
    const files = this.transport.files();
    const resolved = await files.realpath(workingDir);
    assertGitPathArg(files.platform, resolved, 'resolved path');
    return resolved;
  }

  /** A path as the target host sees it: a leading `~` resolved against the host's home (see `resolveGitPath`). */
  private absolute(target: string): Promise<string> {
    return resolveGitPath(this.transport, target);
  }

  private assertWorktreeSuccess(result: { exitCode: number; stdout: string; stderr: string }): void {
    if (result.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${combinedOutput(result)}`);
    }
  }
}
