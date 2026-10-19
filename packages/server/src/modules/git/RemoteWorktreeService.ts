import type { IWorktreeService, WorktreeInfo, WorktreeEntry } from './IWorktreeService';
import type { IServerTransport, ExecResult } from '../servers/transport/ServerTransport';

import { assertSafePath, assertSafeBranch, assertNotOptionLike } from './assertSafeGitArgs';
import { parseWorktreePorcelain } from './parseWorktreePorcelain';
import { combinedOutput, runGit } from './runGit';
import { RemotePathResolver } from './PathContainment';

export class RemoteWorktreeService implements IWorktreeService {
  constructor(private transport: IServerTransport) {}

  async list(workingDir: string): Promise<WorktreeEntry[]> {
    assertSafePath(workingDir, 'workingDir');
    const result = await runGit(this.transport, await this.absolute(workingDir), ['worktree', 'list', '--porcelain']);
    if (result.exitCode !== 0) {
      if (combinedOutput(result).includes('not a git repository')) {
        return [];
      }
      throw new Error(`Failed to list worktrees: ${result.stderr || result.stdout}`);
    }
    return parseWorktreePorcelain(result.stdout);
  }

  async create(workingDir: string, taskId: number, taskSlug: string, baseBranch: string, branchName?: string): Promise<WorktreeInfo> {
    assertSafePath(workingDir, 'workingDir');
    assertSafeBranch(taskSlug, 'taskSlug');
    assertSafeBranch(baseBranch, 'baseBranch');
    assertNotOptionLike(baseBranch, 'baseBranch');
    if (branchName) {
      assertSafeBranch(branchName, 'branchName');
      assertNotOptionLike(branchName, 'branchName');
    }

    const dir = await this.absolute(workingDir);
    const branch = branchName || `task/${taskId}-${taskSlug}`;
    const worktreePath = `${dir}/.worktrees/task-${taskId}`;
    assertNotOptionLike(worktreePath, 'worktreePath');

    await this.exec(`mkdir -p ${dir}/.worktrees`);

    const checkResult = await this.exec(`test -d ${worktreePath} && echo exists || echo no`);
    if (checkResult.stdout.trim() === 'exists') {
      const removed = await runGit(this.transport, dir, ['worktree', 'remove', worktreePath, '--force']);
      if (removed.exitCode !== 0) {
        await runGit(this.transport, dir, ['worktree', 'prune']);
        try { await this.exec(`rm -rf ${worktreePath}`); } catch {}
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
    assertSafePath(worktreePath, 'worktreePath');
    try {
      const result = await this.exec(`test -d ${await this.absolute(worktreePath)} && echo yes || echo no`);
      return result.stdout.trim() === 'yes';
    } catch {
      return false;
    }
  }

  async remove(workingDir: string, worktreePath: string): Promise<void> {
    assertSafePath(workingDir, 'workingDir');
    assertSafePath(worktreePath, 'worktreePath');
    assertNotOptionLike(worktreePath, 'worktreePath');
    const dir = await this.absolute(workingDir);
    // A worktree under the working directory keeps that prefix as resolved: a stored `~/...` path whose directory is already
    // gone cannot be resolved by the host, and `prune` below is what settles such a registration.
    const target = worktreePath.startsWith(`${workingDir}/`) ? `${dir}${worktreePath.slice(workingDir.length)}` : await this.absolute(worktreePath);
    // Both are best-effort cleanup: `remove` fails for a worktree that is already gone, and `prune` then settles the registry.
    await runGit(this.transport, dir, ['worktree', 'remove', target, '--force']);
    await runGit(this.transport, dir, ['worktree', 'prune']);
  }

  async getBranch(worktreePath: string): Promise<string | null> {
    assertSafePath(worktreePath, 'worktreePath');
    try {
      const result = await runGit(this.transport, undefined, ['-C', await this.absolute(worktreePath), 'branch', '--show-current']);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<string | null> {
    assertSafePath(worktreePath, 'worktreePath');
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
   * A path as the target host sees it. A leading `~` is a supported form of a stored working directory (the shell used to
   * expand it); `cwd` and git's arguments are literal, so it is resolved here — the boundary of this service — against the
   * host's home. Any other path is already absolute and passes through.
   */
  private async absolute(target: string): Promise<string> {
    if (target !== '~' && !target.startsWith('~/')) return target;
    const resolved = await new RemotePathResolver(this.transport).resolveRealPath(target);
    assertSafePath(resolved, 'resolved path');
    return resolved;
  }

  private assertWorktreeSuccess(result: { exitCode: number; stdout: string; stderr: string }): void {
    if (result.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${combinedOutput(result)}`);
    }
  }

  /** The file operations of this service (mkdir / test / rm) still go through the shell until IFileOps (#379 P7). */
  private exec(command: string): Promise<ExecResult> {
    return this.transport.exec(command);
  }
}
