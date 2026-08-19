import type { IWorktreeService, WorktreeInfo, WorktreeEntry } from './IWorktreeService';
import type { IServerTransport, ExecResult } from '../servers/transport/ServerTransport';

import { assertSafePath, assertSafeBranch } from './assertSafeGitArgs';
import { parseWorktreePorcelain } from './parseWorktreePorcelain';

export class RemoteWorktreeService implements IWorktreeService {
  constructor(private transport: IServerTransport) {}

  async list(workingDir: string): Promise<WorktreeEntry[]> {
    assertSafePath(workingDir, 'workingDir');
    const result = await this.exec(`cd ${workingDir} && git worktree list --porcelain`);
    if (this.hasGitError(result)) {
      if (`${result.stdout}\n${result.stderr}`.includes('not a git repository')) {
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
    if (branchName) assertSafeBranch(branchName, 'branchName');

    const branch = branchName || `task/${taskId}-${taskSlug}`;
    const worktreePath = `${workingDir}/.worktrees/task-${taskId}`;

    await this.exec(`mkdir -p ${workingDir}/.worktrees`);

    const checkResult = await this.exec(`test -d ${worktreePath} && echo exists || echo no`);
    if (checkResult.stdout.trim() === 'exists') {
      try {
        await this.exec(`cd ${workingDir} && git worktree remove ${worktreePath} --force`);
      } catch {
        try { await this.exec(`cd ${workingDir} && git worktree prune`); } catch {}
        try { await this.exec(`rm -rf ${worktreePath}`); } catch {}
      }
    }

    if (branchName) {
      let branchExists = false;
      try {
        const localCheck = await this.exec(`cd ${workingDir} && git rev-parse --verify ${branch}`);
        branchExists = !this.hasGitError(localCheck);
      } catch {}
      if (!branchExists) {
        try {
          const remoteCheck = await this.exec(`cd ${workingDir} && git rev-parse --verify origin/${branch}`);
          branchExists = !this.hasGitError(remoteCheck);
        } catch {}
      }

      if (branchExists) {
        const result = await this.exec(`cd ${workingDir} && git worktree add ${worktreePath} ${branch}`);
        if (this.hasGitError(result)) {
          const combined = `${result.stdout}\n${result.stderr}`.trim();
          if (combined.includes('already used by worktree')) {
            try { await this.exec(`cd ${workingDir} && git worktree prune`); } catch {}
            const retry = await this.exec(`cd ${workingDir} && git worktree add ${worktreePath} ${branch}`);
            if (this.hasGitError(retry)) {
              const forceRetry = await this.exec(`cd ${workingDir} && git worktree add --force ${worktreePath} ${branch}`);
              this.assertWorktreeSuccess(forceRetry);
            }
          } else {
            throw new Error(`git worktree add failed: ${combined}`);
          }
        }
      } else {
        const result = await this.exec(`cd ${workingDir} && git worktree add -b ${branch} ${worktreePath} ${baseBranch}`);
        this.assertWorktreeSuccess(result);
      }
    } else {
      try { await this.exec(`cd ${workingDir} && git branch -D ${branch} 2>/dev/null`); } catch {}
      const result = await this.exec(`cd ${workingDir} && git worktree add -b ${branch} ${worktreePath} ${baseBranch}`);
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
      const result = await this.exec(`test -d ${worktreePath} && echo yes || echo no`);
      return result.stdout.trim() === 'yes';
    } catch {
      return false;
    }
  }

  async remove(workingDir: string, worktreePath: string): Promise<void> {
    assertSafePath(workingDir, 'workingDir');
    assertSafePath(worktreePath, 'worktreePath');
    try {
      await this.exec(`cd ${workingDir} && git worktree remove ${worktreePath} --force`);
    } catch {}
    try {
      await this.exec(`cd ${workingDir} && git worktree prune`);
    } catch {}
  }

  async getBranch(worktreePath: string): Promise<string | null> {
    assertSafePath(worktreePath, 'worktreePath');
    try {
      const result = await this.exec(`git -C ${worktreePath} branch --show-current`);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<string | null> {
    assertSafePath(worktreePath, 'worktreePath');
    assertSafeBranch(baseBranch, 'baseBranch');
    try {
      const result = await this.exec(`git -c core.quotepath=false -C ${worktreePath} diff --name-status ${baseBranch}...HEAD`);
      const diff = result.stdout.trim();
      if (!diff) return null;
      const files = diff.split('\n').filter(l => /^[AMDRC]/.test(l)).map(l => {
        const [status, ...rest] = l.split('\t');
        return { status, file: rest.join('\t') };
      });
      return files.length > 0 ? JSON.stringify(files) : null;
    } catch {
      try {
        const result = await this.exec(`git -c core.quotepath=false -C ${worktreePath} diff --name-status HEAD~1`);
        const diff = result.stdout.trim();
        if (!diff) return null;
        const files = diff.split('\n').filter(l => /^[AMDRC]/.test(l)).map(l => {
          const [status, ...rest] = l.split('\t');
          return { status, file: rest.join('\t') };
        });
        return files.length > 0 ? JSON.stringify(files) : null;
      } catch {
        return null;
      }
    }
  }

  private hasGitError(result: ExecResult): boolean {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    return /^fatal:|^error:/m.test(combined);
  }

  private assertWorktreeSuccess(result: ExecResult): void {
    if (this.hasGitError(result)) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new Error(`git worktree add failed: ${combined}`);
    }
  }

  private exec(command: string): Promise<ExecResult> {
    return this.transport.exec(command);
  }
}
