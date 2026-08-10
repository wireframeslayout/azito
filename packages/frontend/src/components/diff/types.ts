export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  file: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary: boolean;
  group?: 'staged' | 'unstaged' | 'untracked';
}

export type DiffScope = 'uncommitted' | 'base' | 'commit';

export interface DiffResponse {
  baseBranch: string;
  headBranch: string;
  files: FileDiff[];
  truncated?: boolean;
}

export const STATUS_COLOR: Record<string, string> = {
  A: 'var(--success, #3fb950)',
  D: 'var(--danger, #f85149)',
  M: 'var(--warning, #d29922)',
  R: 'var(--warning, #d29922)',
  U: 'var(--purple, #bc8cff)',
};
