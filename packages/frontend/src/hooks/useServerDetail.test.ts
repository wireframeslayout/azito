import { describe, it, expect } from 'vitest';
import { isValidIsolationReport } from './useServerDetail';

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
});
