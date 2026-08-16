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

export type IsolationDoctorState = 'verified' | 'verifiedStale' | 'unverified' | 'needsAttention' | 'scopedAuthDisabled' | 'scopedAuthUnknown' | null;

/**
 * A server only ever reaches `'verified'`/`'verifiedStale'` when the report
 * is a genuinely valid verification report AND it reports `verified: true`
 * AND `isolationVerifiedAt` is a real, parseable timestamp AND
 * `scopedAuthEnabled === true` (see below) — any one of those failing
 * degrades to `'unverified'` (fail-closed: never render success on an
 * ambiguous or malformed signal), matching the isolation doctor's own
 * "unable to prove clean means fail closed" contract (isolationDoctor.ts's
 * module doc comment).
 *
 * Issue #29 review (5th pass), Important finding 1: the backend now refuses
 * to even RUN the doctor while `scopedAuthEnabled` is false (409
 * `isolation_doctor_requires_scoped_auth` — see routes.ts's POST
 * .../isolation/doctor), but a report already persisted from BEFORE the hub
 * dropped into compat mode (or from before scoped auth was ever turned on)
 * can still sit in the DB looking exactly like a valid, passing
 * verification. Rendering that stale report as `'verified'`/`'verifiedStale'`
 * would repeat the exact deception C-1 exists to prevent — a "検証済み"
 * badge implying layer 3 is actually enforced when, in compat mode, a task
 * principal is operator-equivalent for every route (buildServer.ts's
 * onRequest hook only records `route_auth.would_deny` there). So this check
 * runs FIRST, ahead of every other branch: whenever isolation is declared
 * AND scoped auth is confirmed off, the state is unconditionally
 * `'scopedAuthDisabled'` regardless of what the persisted report says.
 *
 * Final review round, Important finding 2: `scopedAuthEnabled === null`
 * (useHealth's `GET /api/health` fetch hasn't resolved yet, OR it failed
 * outright) was previously treated identically to `scopedAuthEnabled ===
 * true` for the purposes of reaching `'verified'`/`'verifiedStale'` — i.e.
 * "not confirmed off" fell all the way through to rendering success. That is
 * a DIFFERENT signal from "confirmed on": a health-fetch failure means this
 * client genuinely does not know whether scoped auth is enforced right now,
 * and a persisted passing report from an earlier, healthy session is not
 * evidence about the CURRENT state of that gate. Silently keeping the
 * `'verified'` badge up through an unknown health state repeats the same
 * `'検証済み'`-implies-enforced deception C-1 exists to prevent, just via a
 * different unresolved signal instead of a confirmed-off one. `verified`/
 * `verifiedStale` are therefore now reachable ONLY when `scopedAuthEnabled
 * === true`; `null` is its own terminal state, `'scopedAuthUnknown'`
 * ("confirming/could not confirm" — a warn Notice, doctor button disabled —
 * distinct from both the confirmed-on success states and the confirmed-off
 * `'scopedAuthDisabled'` state). `'unverified'`/`'needsAttention'` are
 * unaffected by this gate — they already do not claim success, so a null
 * health state changes nothing about rendering them.
 *
 * This intentionally diverges from `ServerModals.tsx`'s
 * `isolationToggleBlocked`, which still fail-opens on the identical `null`
 * signal for a DIFFERENT decision (whether to let an operator flip the
 * isolation toggle) — blocking a UI action on an unresolved health check has
 * a different cost/benefit than rendering an unverified state as "verified".
 */
export function computeIsolationDoctorState(params: {
  isolationIntent: boolean;
  verificationReport: IsolationReport | null;
  isolationVerifiedAt: string | null | undefined;
  ttlMs: number;
  scopedAuthEnabled: boolean | null;
  now?: number;
}): IsolationDoctorState {
  const { isolationIntent, verificationReport, isolationVerifiedAt, ttlMs, scopedAuthEnabled, now = Date.now() } = params;
  if (!isolationIntent) return null;
  if (scopedAuthEnabled === false) return 'scopedAuthDisabled';
  if (!isValidVerificationReport(verificationReport)) return 'unverified';
  if (verificationReport.verified === false) return 'needsAttention';
  if (!isValidTimestamp(isolationVerifiedAt)) return 'unverified';
  // Every branch above either already returned a non-success state or is a
  // prerequisite check that has nothing to do with scoped auth. From here on
  // the report itself would otherwise justify 'verified'/'verifiedStale', so
  // this is the only point where the scopedAuthEnabled gate applies.
  if (scopedAuthEnabled === null) return 'scopedAuthUnknown';
  return now - new Date(isolationVerifiedAt).getTime() > ttlMs ? 'verifiedStale' : 'verified';
}
