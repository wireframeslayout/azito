import { describe, it, expect } from 'vitest';
import { resolveInputPolicy, resolveEffectiveInputPolicy, ISOLATION_VERIFICATION_TTL_MS } from './ProjectServer';
import type { ProjectServer } from './ProjectServer';

// resolveInputPolicy is the single place that applies the "unset ->
// manual-approval" default (Issue #29 Step 0) — previously duplicated
// independently in ExecutionGate.checkExecutionGate() and in
// projects/routes.ts's PUT handler.

function makeProjectServer(overrides: Partial<ProjectServer> = {}): ProjectServer {
  return {
    projectId: 10,
    serverName: 'test-server',
    workingDirectory: '/work',
    branch: 'main',
    tmuxSession: 'azito',
    inputPolicy: 'manual-approval',
    ...overrides,
  };
}

describe('resolveInputPolicy', () => {
  it('returns "manual-approval" when the project_servers row is null (no row exists yet)', () => {
    expect(resolveInputPolicy(null)).toBe('manual-approval');
  });

  it('returns "manual-approval" when the project_servers row is undefined', () => {
    expect(resolveInputPolicy(undefined)).toBe('manual-approval');
  });

  it('returns the row\'s own inputPolicy when set to "deny"', () => {
    expect(resolveInputPolicy(makeProjectServer({ inputPolicy: 'deny' }))).toBe('deny');
  });

  it('returns the row\'s own inputPolicy when set to "manual-approval"', () => {
    expect(resolveInputPolicy(makeProjectServer({ inputPolicy: 'manual-approval' }))).toBe('manual-approval');
  });

  it('returns the row\'s own inputPolicy when set to "allow"', () => {
    expect(resolveInputPolicy(makeProjectServer({ inputPolicy: 'allow' }))).toBe('allow');
  });
});

// resolveEffectiveInputPolicy is the server-side 3-point AND gate for
// 'allow' (Issue #29 Step 3a): server.isolationIntent AND a current
// (within-TTL) isolationVerifiedAt AND scopedAuthEnabled. Any one missing
// degrades to 'manual-approval' with a specific reason; 'deny'/
// 'manual-approval' requests are never touched by this gate.

const NOW = new Date('2026-08-16T12:00:00.000Z').getTime();
const VERIFIED_JUST_NOW = new Date(NOW).toISOString();
const VERIFIED_EXPIRED = new Date(NOW - ISOLATION_VERIFICATION_TTL_MS - 1).toISOString();
const VERIFIED_AT_TTL_BOUNDARY = new Date(NOW - ISOLATION_VERIFICATION_TTL_MS).toISOString();

function makeIsolatedServer(overrides: { isolationIntent?: boolean; isolationVerifiedAt?: string | null } = {}) {
  return { isolationIntent: true, isolationVerifiedAt: VERIFIED_JUST_NOW, ...overrides };
}

describe('resolveEffectiveInputPolicy', () => {
  it('passes "deny" through unchanged regardless of server/scoped-auth state', () => {
    const result = resolveEffectiveInputPolicy(makeProjectServer({ inputPolicy: 'deny' }), null, false, NOW);
    expect(result).toEqual({ requestedPolicy: 'deny', effectivePolicy: 'deny', allowDegradedReason: null });
  });

  it('passes "manual-approval" through unchanged regardless of server/scoped-auth state', () => {
    const result = resolveEffectiveInputPolicy(makeProjectServer({ inputPolicy: 'manual-approval' }), null, false, NOW);
    expect(result).toEqual({ requestedPolicy: 'manual-approval', effectivePolicy: 'manual-approval', allowDegradedReason: null });
  });

  it('degrades "allow" to "manual-approval" with reason "not_isolated" when server is null', () => {
    const result = resolveEffectiveInputPolicy(makeProjectServer({ inputPolicy: 'allow' }), null, true, NOW);
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'manual-approval', allowDegradedReason: 'not_isolated' });
  });

  it('degrades "allow" to "manual-approval" with reason "not_isolated" when server.isolationIntent is false', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer({ isolationIntent: false }),
      true,
      NOW,
    );
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'manual-approval', allowDegradedReason: 'not_isolated' });
  });

  it('degrades "allow" to "manual-approval" with reason "verification_missing" when isolationVerifiedAt is null', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer({ isolationVerifiedAt: null }),
      true,
      NOW,
    );
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'manual-approval', allowDegradedReason: 'verification_missing' });
  });

  it('degrades "allow" to "manual-approval" with reason "verification_expired" when isolationVerifiedAt is older than the TTL', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer({ isolationVerifiedAt: VERIFIED_EXPIRED }),
      true,
      NOW,
    );
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'manual-approval', allowDegradedReason: 'verification_expired' });
  });

  it('treats an unparseable isolationVerifiedAt as expired ("verification_expired"), never as "verified just now"', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer({ isolationVerifiedAt: 'not-a-date' }),
      true,
      NOW,
    );
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'manual-approval', allowDegradedReason: 'verification_expired' });
  });

  it('degrades "allow" to "manual-approval" with reason "scoped_auth_disabled" when every other condition is met but scopedAuthEnabled is false', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer(),
      false,
      NOW,
    );
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'manual-approval', allowDegradedReason: 'scoped_auth_disabled' });
  });

  it('keeps "allow" effective when all three conditions hold (verified just now)', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer(),
      true,
      NOW,
    );
    expect(result).toEqual({ requestedPolicy: 'allow', effectivePolicy: 'allow', allowDegradedReason: null });
  });

  it('TTL boundary: exactly ISOLATION_VERIFICATION_TTL_MS old still counts as within TTL (strictly-greater-than comparison)', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer({ isolationVerifiedAt: VERIFIED_AT_TTL_BOUNDARY }),
      true,
      NOW,
    );
    expect(result.effectivePolicy).toBe('allow');
    expect(result.allowDegradedReason).toBeNull();
  });

  it('TTL boundary: one millisecond past the TTL degrades to "verification_expired"', () => {
    const result = resolveEffectiveInputPolicy(
      makeProjectServer({ inputPolicy: 'allow' }),
      makeIsolatedServer({ isolationVerifiedAt: VERIFIED_EXPIRED }),
      true,
      NOW,
    );
    expect(result.effectivePolicy).toBe('manual-approval');
    expect(result.allowDegradedReason).toBe('verification_expired');
  });
});
