import { describe, it, expect } from 'vitest';
import { computeIsolationDoctorState, isValidVerificationReport } from './isolationDoctorState';
import type { IsolationReport } from '../../../hooks/useServerDetail';

const TTL = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-16T00:00:00Z').getTime();

function verified(overrides: Partial<IsolationReport> = {}): IsolationReport {
  return { kind: 'verification', verified: true, checks: [], ...overrides };
}

describe('isValidVerificationReport', () => {
  it('accepts a well-formed verification report', () => {
    expect(isValidVerificationReport(verified())).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidVerificationReport(null)).toBe(false);
  });

  // Follow-up review round, Minor finding 4: the exact scenario the fix
  // closes — a cleanup-shaped report reaching the verification field must
  // never be read as if it carried a `verified` boolean.
  it('rejects a cleanup-kind report even though the union type would allow reading it', () => {
    const cleanupReport = { kind: 'cleanup', cleanup: 'done' } as unknown as IsolationReport;
    expect(isValidVerificationReport(cleanupReport)).toBe(false);
  });

  it('rejects a verification-kind report missing the verified field', () => {
    const malformed = { kind: 'verification', checks: [] } as unknown as IsolationReport;
    expect(isValidVerificationReport(malformed)).toBe(false);
  });
});

describe('computeIsolationDoctorState', () => {
  it('returns null when the server does not declare isolationIntent', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: false,
      verificationReport: verified(),
      isolationVerifiedAt: '2026-08-15T00:00:00Z',
      ttlMs: TTL,
      now: NOW,
    })).toBeNull();
  });

  it('returns unverified when there is no report at all', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: null,
      isolationVerifiedAt: null,
      ttlMs: TTL,
      now: NOW,
    })).toBe('unverified');
  });

  // The core bug this fix closes: a cleanup report landing on the
  // verification field must degrade to 'unverified', never render as
  // success just because `verified === false` didn't literally match.
  it('returns unverified (never verified) when the report is cleanup-shaped, not verification-shaped', () => {
    const cleanupReport = { kind: 'cleanup', cleanup: 'done' } as unknown as IsolationReport;
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: cleanupReport,
      isolationVerifiedAt: '2026-08-15T00:00:00Z',
      ttlMs: TTL,
      now: NOW,
    })).toBe('unverified');
  });

  it('returns needsAttention when the report is verification-shaped with verified: false', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: verified({ verified: false }),
      isolationVerifiedAt: null,
      ttlMs: TTL,
      now: NOW,
    })).toBe('needsAttention');
  });

  it('returns verified when the report passes and isolationVerifiedAt is a fresh, valid timestamp', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: verified(),
      isolationVerifiedAt: new Date(NOW - 1000).toISOString(),
      ttlMs: TTL,
      now: NOW,
    })).toBe('verified');
  });

  it('returns verifiedStale when the report passes but isolationVerifiedAt is older than the TTL', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: verified(),
      isolationVerifiedAt: new Date(NOW - TTL - 1000).toISOString(),
      ttlMs: TTL,
      now: NOW,
    })).toBe('verifiedStale');
  });

  // Follow-up review round, Minor finding 4: an unparseable isolationVerifiedAt
  // must not silently read as "verified just now" — Date.now() - NaN
  // comparisons are always false (never "stale"), which without this guard
  // would fall through to 'verified'.
  it('returns unverified when the report passes but isolationVerifiedAt is missing', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: verified(),
      isolationVerifiedAt: null,
      ttlMs: TTL,
      now: NOW,
    })).toBe('unverified');
  });

  it('returns unverified when the report passes but isolationVerifiedAt is not a parseable timestamp', () => {
    expect(computeIsolationDoctorState({
      isolationIntent: true,
      verificationReport: verified(),
      isolationVerifiedAt: 'not-a-date',
      ttlMs: TTL,
      now: NOW,
    })).toBe('unverified');
  });
});
