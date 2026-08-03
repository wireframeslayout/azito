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
}

export interface DiffResponse {
  baseBranch: string;
  headBranch: string;
  files: FileDiff[];
  truncated?: boolean;
}

export const STATUS_COLOR: Record<string, string> = {
  A: 'var(--success, #3fb950)',
  D: 'var(--danger, #f85149)',
  M: 'var(--accent, #58a6ff)',
  R: 'var(--warning, #d29922)',
};
