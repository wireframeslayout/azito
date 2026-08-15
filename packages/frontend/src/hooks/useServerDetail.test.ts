import { describe, it, expect } from 'vitest';
import { isValidIsolationReport, hasIsolationReportField } from './useServerDetail';

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

  it('accepts a verification report', () => {
    expect(isValidIsolationReport({ kind: 'verification' })).toBe(true);
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
  });

  // A verification report only needs the discriminant today — see this
  // function's doc comment for why that's the deliberately minimal bar
  // (the doctor variant isn't implemented server-side yet).
  it('accepts a verification report with extra unknown fields', () => {
    expect(isValidIsolationReport({ kind: 'verification', someFutureField: 1 })).toBe(true);
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
