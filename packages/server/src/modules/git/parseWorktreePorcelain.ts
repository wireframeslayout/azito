export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  if (!output.trim()) return [];

  return output.trim().split(/\n\s*\n/).map((record, index) => {
    const lines = record.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '';
    const head = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length) ?? '';
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    const isDetached = lines.includes('detached');

    return {
      path,
      branch: isDetached || !branchRef ? null : branchRef.replace(/^refs\/heads\//, ''),
      head,
      isMain: index === 0,
      locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
    };
  });
}
