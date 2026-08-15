import { describe, it, expect } from 'vitest';
import { resolveInputPolicy } from './ProjectServer';
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
