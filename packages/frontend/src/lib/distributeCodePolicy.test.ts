import { describe, it, expect } from 'vitest';
import { isDistributeCodeLocked, shouldShowDistributeCodeBadge } from './distributeCodePolicy';

// Issue #87 third-party review, seventh pass, Minor finding 3: an isolated
// server distributes code unconditionally on the backend (`isolationIntent`),
// so the distribute-code toggle must be locked ON for it, and the
// project-server list badge must show even when the saved `distributeCode`
// flag is stale/false.
describe('isDistributeCodeLocked', () => {
  it('is locked (true) for an isolated server', () => {
    expect(isDistributeCodeLocked({ isolationIntent: true })).toBe(true);
  });

  it('is not locked for a non-isolated server', () => {
    expect(isDistributeCodeLocked({ isolationIntent: false })).toBe(false);
  });

  it('is not locked when isolationIntent is undefined', () => {
    expect(isDistributeCodeLocked({})).toBe(false);
  });

  it('is not locked when server itself is undefined', () => {
    expect(isDistributeCodeLocked(undefined)).toBe(false);
  });
});

describe('shouldShowDistributeCodeBadge', () => {
  it('shows the badge for an isolated server even when distributeCode is false (stale saved flag)', () => {
    expect(shouldShowDistributeCodeBadge({ isolationIntent: true }, false)).toBe(true);
  });

  it('shows the badge for an isolated server when distributeCode is undefined', () => {
    expect(shouldShowDistributeCodeBadge({ isolationIntent: true }, undefined)).toBe(true);
  });

  it('shows the badge for a non-isolated server when distributeCode is true', () => {
    expect(shouldShowDistributeCodeBadge({ isolationIntent: false }, true)).toBe(true);
  });

  it('hides the badge for a non-isolated server when distributeCode is false', () => {
    expect(shouldShowDistributeCodeBadge({ isolationIntent: false }, false)).toBe(false);
  });

  it('hides the badge when the server is unknown and distributeCode is false', () => {
    expect(shouldShowDistributeCodeBadge(undefined, false)).toBe(false);
  });
});
