import { hostFeatureSupport, type HostFeature, type HostPlatformInfo } from '@azito/shared';
import { HostProfileError } from './hostProfile';
import { shellDialectFor, type ShellDialect } from './shellDialect';

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
 * The dialect for a line that is typed into a pane to start or resume a worker (the launch line, a respawn line, the supervisor
 * wrap, the `cd` before them). It is the one place every such line is built through, so a host that cannot run a worker in a pane
 * (Windows, #371) is refused here even by a path that opened a bare pane first: nothing reaches its cmd.exe.
 */
export function workerLineDialect(profile: HostPlatformInfo | null | undefined, operation: string): ShellDialect {
  assertHostFeature(profile, 'workerLaunch', operation);
  return shellDialectFor(profile ?? null);
}
