import type { HostPlatform } from '../../shared/os/hostEnv';
import { normalizeGitPath } from './gitPath';

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
}

/** `platform` is the OS git ran on: its paths are printed with `/` on win32 and are returned in the host's own spelling. */
export function parseWorktreePorcelain(output: string, platform: HostPlatform): WorktreeEntry[] {
  if (!output.trim()) return [];

  const text = platform === 'win32' ? output.replace(/\r\n/g, '\n') : output;
  return text.trim().split(/\n\s*\n/).map((record, index) => {
    const lines = record.split('\n');
    const path = normalizeGitPath(platform, lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '');
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
