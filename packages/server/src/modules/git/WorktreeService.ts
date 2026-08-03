import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import type { IWorktreeService, WorktreeInfo } from './IWorktreeService';
import { assertSafePath, assertSafeBranch } from './assertSafeGitArgs';

export class LocalWorktreeService implements IWorktreeService {
  async create(workingDir: string, taskId: number, taskSlug: string, baseBranch: string, branchName?: string): Promise<WorktreeInfo> {
    assertSafePath(workingDir, 'workingDir');
    assertSafeBranch(taskSlug, 'taskSlug');
    assertSafeBranch(baseBranch, 'baseBranch');
    if (branchName) assertSafeBranch(branchName, 'branchName');

    const branch = branchName || `task/${taskId}-${taskSlug}`;
    const worktreePath = `${workingDir}/.worktrees/task-${taskId}`;
    const opts = { cwd: workingDir, encoding: 'utf-8' as const, timeout: 15000 };

    mkdirSync(`${workingDir}/.worktrees`, { recursive: true });

    if (existsSync(worktreePath)) {
      try {
        execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], opts);
      } catch {
        try { execFileSync('git', ['worktree', 'prune'], opts); } catch {}
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }

    if (branchName) {
      const branchExists = (() => {
        try {
          execFileSync('git', ['rev-parse', '--verify', branch], opts);
          return true;
        } catch {
          try {
            execFileSync('git', ['rev-parse', '--verify', `origin/${branch}`], opts);
            return true;
          } catch {
            return false;
          }
        }
      })();

      if (branchExists) {
        try {
          execFileSync('git', ['worktree', 'add', worktreePath, branch], opts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('already used by worktree')) {
            try { execFileSync('git', ['worktree', 'prune'], opts); } catch {}
            try {
              execFileSync('git', ['worktree', 'add', worktreePath, branch], opts);
            } catch {
              execFileSync('git', ['worktree', 'add', '--force', worktreePath, branch], opts);
            }
          } else {
            throw err;
          }
        }
      } else {
        execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], opts);
      }
    } else {
      try {
        execFileSync('git', ['branch', '-D', branch], opts);
      } catch {}
      execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], opts);
    }

    return { path: worktreePath, branch };
  }

  async exists(worktreePath: string): Promise<boolean> {
    return existsSync(worktreePath);
  }

  async remove(workingDir: string, worktreePath: string): Promise<void> {
    assertSafePath(workingDir, 'workingDir');
    assertSafePath(worktreePath, 'worktreePath');

    const opts = { cwd: workingDir, encoding: 'utf-8' as const, timeout: 15000 };
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], opts);
    } catch {}
    try {
      execFileSync('git', ['worktree', 'prune'], opts);
    } catch {}
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<string | null> {
    assertSafePath(worktreePath, 'worktreePath');
    assertSafeBranch(baseBranch, 'baseBranch');

    const opts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 15000 };
    try {
      const diff = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-status', `${baseBranch}...HEAD`], opts).trim();
      if (!diff) return null;
      const files = diff.split('\n').filter(l => /^[AMDRC]/.test(l)).map(l => {
        const [status, ...rest] = l.split('\t');
        return { status, file: rest.join('\t') };
      });
      return files.length > 0 ? JSON.stringify(files) : null;
    } catch {
      try {
        const diff = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-status', 'HEAD~1'], opts).trim();
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

  async getBranch(worktreePath: string): Promise<string | null> {
    assertSafePath(worktreePath, 'worktreePath');

    const opts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 15000 };
    try {
      return execFileSync('git', ['branch', '--show-current'], opts).trim() || null;
    } catch {
      return null;
    }
  }

}
