export type { WorktreeEntry } from './parseWorktreePorcelain';
import type { WorktreeEntry } from './parseWorktreePorcelain';

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface IWorktreeService {
  create(workingDir: string, taskId: number, taskSlug: string, baseBranch: string, branchName?: string): Promise<WorktreeInfo>;
  list(workingDir: string): Promise<WorktreeEntry[]>;
  exists(worktreePath: string): Promise<boolean>;
  remove(workingDir: string, worktreePath: string): Promise<void>;
  getBranch(worktreePath: string): Promise<string | null>;
  getDiff(worktreePath: string, baseBranch: string): Promise<string | null>;
}
