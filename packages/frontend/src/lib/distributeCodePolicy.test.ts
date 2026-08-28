import { describe, it, expect } from 'vitest';
import { isDistributeCodeLocked, resolveDistributeCodeForSave, shouldShowDistributeCodeBadge } from './distributeCodePolicy';

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

// Issue #87 review, eighth pass, Important finding 1: opening/saving an
// isolated server must not persist a forced `distribute_code: true` — the
// backend distributes unconditionally regardless of this flag, so writing
// `true` here would leave a stale opt-in behind once isolation is later
// disabled.
describe('resolveDistributeCodeForSave', () => {
  it('omits the value (returns undefined) for a locked (isolated) server, regardless of the form value', () => {
    expect(resolveDistributeCodeForSave({ isolationIntent: true }, true)).toBeUndefined();
    expect(resolveDistributeCodeForSave({ isolationIntent: true }, false)).toBeUndefined();
  });

  it('passes through the user-chosen value for a non-isolated server', () => {
    expect(resolveDistributeCodeForSave({ isolationIntent: false }, true)).toBe(true);
    expect(resolveDistributeCodeForSave({ isolationIntent: false }, false)).toBe(false);
  });

  it('passes through the user-chosen value when the server is unknown', () => {
    expect(resolveDistributeCodeForSave(undefined, true)).toBe(true);
  });
});
