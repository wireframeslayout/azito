import { hostFeatureSupport, type HostFeature, type HostPlatformInfo } from '@azito/shared';
import { HostProfileError } from './hostProfile';

/**
 * Refuses an operation whose feature the server's host does not support yet (`hostFeatureSupport`, the one table the UI
 * also reads), before the operation touches anything. The refusal is `unsupported_os` (501 with this text): a limit of the
 * host's OS, not a failure. A null profile (an agent registered before the OS was kept) is a Unix host.
 */
export function assertHostFeature(profile: HostPlatformInfo | null | undefined, feature: HostFeature, operation: string): void {
  const support = hostFeatureSupport(profile, feature);
  if (support.available) return;
  // `yet` only for a feature that is coming (it has a tracking issue).
  const message = support.issue === null
    ? `${operation} is not available on Windows hosts.`
    : `${operation} is not available on Windows hosts yet (tracked in #${support.issue}).`;
  throw new HostProfileError('unsupported_os', message);
}

/**
 * How a worker (claude / codex / a command) is started in a host's pane (#371).
 *  - POSIX (and a host whose OS is not recorded, which is a Unix one): a line typed into the pane's shell, after a directory change.
 *  - Windows: the mux starts the program itself, from its argv and working directory (`pane.open`). No line is typed, so there is
 *    no PowerShell / cmd.exe quoting, no `.ps1`-before-`.cmd` lookup and no directory change; misao resolves `claude` to `claude.cmd`
 *    through PATHEXT and names the pane's profile after the program. A task's worker starts the same way, so the task's worktree is made
 *    before its window (the directory must be known when the window is created).
 */
export function workerStartsAsProgram(profile: HostPlatformInfo | null | undefined): boolean {
  return profile?.platform === 'win32';
}
