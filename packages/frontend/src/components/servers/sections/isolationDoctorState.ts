import type { IsolationReport } from '../../../hooks/useServerDetail';

// Follow-up review round, Minor finding 4: extracted out of OverviewSection.tsx
// so this discriminant-sensitive logic can be covered directly (pure logic,
// no rendering) — matches this codebase's existing pattern of pulling
// display-adjacent decision logic into a co-located, independently tested
// module (e.g. lib/activityPillLogic.ts).
//
// `isolationReport` is typed as the shared `IsolationReport` union
// (`kind: 'cleanup' | 'verification'`) — a value arriving on the
// isolationReport FIELD is not guaranteed, by the type alone, to actually be
// a verification-shaped report (a stale/pre-split DB row, or a future
// server-side regression writing the wrong field, would still type-check).
// The previous version read `verificationReport.verified === false` without
// ever checking `kind`, so a cleanup-shaped report (no `verified` field at
// all) fell through that `=== false` check and rendered as "verified" — a
// false success. Every read below is gated on the discriminant AND the
// shape it implies actually being present.
export function isValidVerificationReport(
  report: IsolationReport | null,
): report is IsolationReport & { verified: boolean } {
  return report !== null && report.kind === 'verification' && typeof report.verified === 'boolean';
}

/** True only for a string that `Date` can actually parse into a real
 * instant — an unparseable `isolationVerifiedAt` must not silently read as
 * "verified just now" (a NaN timestamp makes every staleness comparison
 * false, i.e. never "stale"). */
export function isValidTimestamp(value: string | null | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

export type IsolationDoctorState = 'verified' | 'verifiedStale' | 'unverified' | 'needsAttention' | null;

/**
 * A server only ever reaches `'verified'`/`'verifiedStale'` when the report
 * is a genuinely valid verification report AND it reports `verified: true`
 * AND `isolationVerifiedAt` is a real, parseable timestamp — any one of
 * those failing degrades to `'unverified'` (fail-closed: never render
 * success on an ambiguous or malformed signal), matching the isolation
 * doctor's own "unable to prove clean means fail closed" contract
 * (isolationDoctor.ts's module doc comment).
 */
export function computeIsolationDoctorState(params: {
  isolationIntent: boolean;
  verificationReport: IsolationReport | null;
  isolationVerifiedAt: string | null | undefined;
  ttlMs: number;
  now?: number;
}): IsolationDoctorState {
  const { isolationIntent, verificationReport, isolationVerifiedAt, ttlMs, now = Date.now() } = params;
  if (!isolationIntent) return null;
  if (!isValidVerificationReport(verificationReport)) return 'unverified';
  if (verificationReport.verified === false) return 'needsAttention';
  if (!isValidTimestamp(isolationVerifiedAt)) return 'unverified';
  return now - new Date(isolationVerifiedAt).getTime() > ttlMs ? 'verifiedStale' : 'verified';
}
