import type { TFunction } from 'i18next';
import { hostFeatureSupport, type HostFeature, type HostPlatformInfo } from '@azito/shared';

/**
 * Why a feature is closed on a server's host, in the user's language; null when it is open. The decision is
 * `hostFeatureSupport` (shared); this only words it. `profile` is the server's `hostProfile` (null: a Unix agent from before the OS was kept).
 */
export function hostFeatureBlockReason(profile: HostPlatformInfo | null | undefined, feature: HostFeature, t: TFunction): string | null {
  const support = hostFeatureSupport(profile, feature);
  if (support.available) return null;
  return support.issue === null ? t('common:hostFeature.windowsNoTmux') : t('common:hostFeature.windowsPending', { issue: support.issue });
}

/** The body of an API answer that refused for the host's OS (`{ error: <the reason in words>, code: 'unsupported_os' }`). */
export function isUnsupportedOsAnswer(body: unknown): body is { error: string; code: 'unsupported_os' } {
  if (!body || typeof body !== 'object') return false;
  const { error, code } = body as { error?: unknown; code?: unknown };
  return code === 'unsupported_os' && typeof error === 'string';
}

/** Words an `unsupported_os` answer: the hub's reason, under a line that says it is the host's OS and not a failure. */
export function describeUnsupportedOs(body: { error: string }, t: TFunction): string {
  return t('common:hostFeature.apiRefused', { reason: body.error });
}
