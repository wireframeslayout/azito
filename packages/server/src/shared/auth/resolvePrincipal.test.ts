import { describe, it, expect, vi } from 'vitest';
import { resolvePrincipal } from './resolvePrincipal';

describe('resolvePrincipal', () => {
  it('resolves an operator principal for a header that verifies as the UI token', () => {
    const verifyUiToken = vi.fn().mockReturnValue(true);
    const taskTokenRepo = { verify: vi.fn().mockReturnValue(false) };
    const principal = resolvePrincipal('Bearer ui-token', { verifyUiToken, taskTokenRepo });
    expect(principal).toEqual({ class: 'operator' });
  });

  it('resolves a task principal for a valid azt.task.<id>.<secret> header', () => {
    const verifyUiToken = vi.fn().mockReturnValue(false);
    const taskTokenRepo = { verify: vi.fn().mockReturnValue(true) };
    const secret = 'a'.repeat(64);
    const principal = resolvePrincipal(`Bearer azt.task.42.${secret}`, { verifyUiToken, taskTokenRepo });
    expect(principal).toEqual({ class: 'task', id: 42 });
    expect(taskTokenRepo.verify).toHaveBeenCalledWith(42, secret);
    expect(verifyUiToken).not.toHaveBeenCalled();
  });

  it('fails closed (does not fall back to the UI token check) when a task-token-shaped header fails verification', () => {
    const verifyUiToken = vi.fn().mockReturnValue(true);
    const taskTokenRepo = { verify: vi.fn().mockReturnValue(false) };
    const secret = 'b'.repeat(64);
    const principal = resolvePrincipal(`Bearer azt.task.1.${secret}`, { verifyUiToken, taskTokenRepo });
    expect(principal).toBeNull();
    expect(verifyUiToken).not.toHaveBeenCalled();
  });

  it('returns null for a missing header', () => {
    const verifyUiToken = vi.fn().mockReturnValue(false);
    const taskTokenRepo = { verify: vi.fn().mockReturnValue(false) };
    expect(resolvePrincipal(undefined, { verifyUiToken, taskTokenRepo })).toBeNull();
  });

  // Issue #28 third-party review finding 4: an oversized taskId used to
  // parse into a non-safe-integer that better-sqlite3 would throw on,
  // turning a malformed token into a 500 instead of a clean 401. It must
  // never even reach taskTokenRepo.verify().
  it('never calls taskTokenRepo.verify() for a task-token-shaped header whose taskId overflows a safe integer, and does not throw', () => {
    const verifyUiToken = vi.fn().mockReturnValue(false);
    const taskTokenRepo = { verify: vi.fn().mockReturnValue(true) };
    const secret = 'c'.repeat(64);
    const hugeTaskId = '9'.repeat(20);
    let principal;
    expect(() => {
      principal = resolvePrincipal(`Bearer azt.task.${hugeTaskId}.${secret}`, { verifyUiToken, taskTokenRepo });
    }).not.toThrow();
    expect(principal).toBeNull();
    expect(taskTokenRepo.verify).not.toHaveBeenCalled();
  });
});
