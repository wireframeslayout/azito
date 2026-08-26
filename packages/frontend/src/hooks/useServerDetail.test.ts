import { describe, it, expect } from 'vitest';
import { isValidIsolationReport, hasIsolationReportField, hasIsolationCleanupReportField } from './useServerDetail';

// Issue #29 review, Important finding 3: isolationReportUnavailable hinges
// on this shape check to tell "a report this hook understands" apart from
// "malformed / not a report at all" — see useServerDetail's own doc comment
// on why a bare .catch(() => null) could not make that distinction. Pure
// logic, so it's covered directly rather than through the full hook (which
// would need network mocking beyond this frontend test setup's current
// scope — see the file's vitest.config.ts, node environment / no MSW here).
describe('isValidIsolationReport', () => {
  it('accepts a cleanup report', () => {
    expect(isValidIsolationReport({ kind: 'cleanup', cleanup: 'done' })).toBe(true);
  });

  // Issue #29 Step 2 C: now that the doctor actually writes this variant,
  // the bare discriminant is no longer enough — `verified`/`checks` must be
  // present in the shape the doctor always produces.
  it('accepts a verification report with verified + checks', () => {
    expect(isValidIsolationReport({ kind: 'verification', verified: true, checks: [] })).toBe(true);
  });

  it('rejects a verification report missing verified/checks', () => {
    expect(isValidIsolationReport({ kind: 'verification' })).toBe(false);
    expect(isValidIsolationReport({ kind: 'verification', verified: true })).toBe(false);
    expect(isValidIsolationReport({ kind: 'verification', checks: [] })).toBe(false);
  });

  it('accepts a verification report whose checks entries all have id/status/detail', () => {
    expect(isValidIsolationReport({
      kind: 'verification',
      verified: false,
      checks: [{ id: 'same_host', status: 'pass', detail: 'ok' }, { id: 'gh_unauthenticated', status: 'unknown', detail: 'n/a' }],
    })).toBe(true);
  });

  // Step 2 review, Minor #5: OverviewSection.tsx reads `c.status`/`c.id` off
  // every checks entry unconditionally (its failedOrUnknownChecks filter/map) —
  // an entry that isn't a well-formed IsolationCheck must fail the WHOLE
  // report closed (unavailable), not be silently passed through to a
  // component that will throw on it.
  it('rejects a verification report when any checks entry is null', () => {
    expect(isValidIsolationReport({
      kind: 'verification',
      verified: false,
      checks: [{ id: 'same_host', status: 'pass', detail: 'ok' }, null],
    })).toBe(false);
  });

  it('rejects a verification report when a checks entry is missing required fields', () => {
    expect(isValidIsolationReport({ kind: 'verification', verified: false, checks: [{}] })).toBe(false);
    expect(isValidIsolationReport({ kind: 'verification', verified: false, checks: [{ id: 'x', detail: 'd' }] })).toBe(false);
    expect(isValidIsolationReport({ kind: 'verification', verified: false, checks: [{ id: 'x', status: 'pass' }] })).toBe(false);
  });

  it('rejects a verification report when a checks entry has an invalid status value', () => {
    expect(isValidIsolationReport({
      kind: 'verification',
      verified: false,
      checks: [{ id: 'x', status: 'not-a-real-status', detail: 'd' }],
    })).toBe(false);
  });

  it('rejects a verification report when a checks entry has a non-string id/detail', () => {
    expect(isValidIsolationReport({ kind: 'verification', verified: false, checks: [{ id: 1, status: 'pass', detail: 'd' }] })).toBe(false);
    expect(isValidIsolationReport({ kind: 'verification', verified: false, checks: [{ id: 'x', status: 'pass', detail: null }] })).toBe(false);
  });

  it('rejects an object missing kind', () => {
    expect(isValidIsolationReport({ cleanup: 'done' })).toBe(false);
  });

  it('rejects an object with an unrecognized kind', () => {
    expect(isValidIsolationReport({ kind: 'something-else' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isValidIsolationReport(null)).toBe(false);
    expect(isValidIsolationReport(undefined)).toBe(false);
    expect(isValidIsolationReport('cleanup')).toBe(false);
    expect(isValidIsolationReport(42)).toBe(false);
    expect(isValidIsolationReport([])).toBe(false);
  });

  // Issue #29 review (5th pass), Important finding 3: kind==='cleanup' must
  // also carry a recognized `cleanup` value — a report the UI's
  // cleanup-outcome switch has no defined behavior for is exactly as
  // unusable to it as a missing `kind`.
  it('rejects a cleanup report missing the cleanup field', () => {
    expect(isValidIsolationReport({ kind: 'cleanup' })).toBe(false);
  });

  it('rejects a cleanup report with an unrecognized cleanup value', () => {
    expect(isValidIsolationReport({ kind: 'cleanup', cleanup: 'not-a-real-outcome' })).toBe(false);
  });

  it('accepts every recognized cleanup value', () => {
    expect(isValidIsolationReport({ kind: 'cleanup', cleanup: 'done' })).toBe(true);
    expect(isValidIsolationReport({ kind: 'cleanup', cleanup: 'failed' })).toBe(true);
    expect(isValidIsolationReport({ kind: 'cleanup', cleanup: 'skipped' })).toBe(true);
    // Issue #29 review (final pass), Important finding 2: 'pending' is the
    // marker updateIsolationIntent now writes atomically on a false->true
    // flip, before any cleanup attempt has actually run — a legitimate
    // value this parser must accept, not reject as "unrecognized" (which
    // would surface as isolationReportUnavailable instead of the intended
    // isolationCleanupWarning).
    expect(isValidIsolationReport({ kind: 'cleanup', cleanup: 'pending' })).toBe(true);
  });

  it('accepts a verification report with extra unknown fields alongside verified/checks', () => {
    expect(isValidIsolationReport({ kind: 'verification', verified: false, checks: [{ id: 'x', status: 'fail', detail: 'd' }], probedAt: 't', someFutureField: 1 })).toBe(true);
  });
});

// Issue #29 review (5th pass), Important finding 3: hasIsolationReportField
// is the guard that stops a null/array/scalar detail-fetch body from ever
// reaching a `.isolationReport` property access (which throws for `null`)
// before isValidIsolationReport is even consulted.
describe('hasIsolationReportField', () => {
  it('accepts a plain object owning isolationReport (even when null)', () => {
    expect(hasIsolationReportField({ isolationReport: null })).toBe(true);
    expect(hasIsolationReportField({ isolationReport: '{"kind":"cleanup","cleanup":"done"}' })).toBe(true);
  });

  it('rejects a null body', () => {
    expect(hasIsolationReportField(null)).toBe(false);
  });

  it('rejects an array body', () => {
    expect(hasIsolationReportField([{ isolationReport: null }])).toBe(false);
  });

  it('rejects a scalar body', () => {
    expect(hasIsolationReportField('not-an-object')).toBe(false);
    expect(hasIsolationReportField(42)).toBe(false);
  });

  it('rejects an object that does not own isolationReport', () => {
    expect(hasIsolationReportField({ name: 'srv1' })).toBe(false);
  });
});

// Review round (Important finding 4): the cleanup-field counterpart to
// hasIsolationReportField above — same predicate, different field name,
// since the server now splits the two outcomes into separate columns.
describe('hasIsolationCleanupReportField', () => {
  it('accepts a plain object owning isolationCleanupReport (even when null)', () => {
    expect(hasIsolationCleanupReportField({ isolationCleanupReport: null })).toBe(true);
    expect(hasIsolationCleanupReportField({ isolationCleanupReport: '{"kind":"cleanup","cleanup":"done"}' })).toBe(true);
  });

  it('rejects a body that only owns isolationReport, not isolationCleanupReport', () => {
    expect(hasIsolationCleanupReportField({ isolationReport: null })).toBe(false);
  });

  it('rejects a null/array/scalar body', () => {
    expect(hasIsolationCleanupReportField(null)).toBe(false);
    expect(hasIsolationCleanupReportField([{ isolationCleanupReport: null }])).toBe(false);
    expect(hasIsolationCleanupReportField('not-an-object')).toBe(false);
  });
});
