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
});
