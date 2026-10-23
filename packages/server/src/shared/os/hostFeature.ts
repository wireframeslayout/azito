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
  const tracking = support.issue === null ? '' : ` (tracked in #${support.issue})`;
  throw new HostProfileError('unsupported_os', `${operation} is not available on Windows hosts yet${tracking}.`);
}
