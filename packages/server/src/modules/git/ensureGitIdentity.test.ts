import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureGitIdentity } from './ensureGitIdentity';
import { getGitConfigValue, setGitConfigValue } from './gitConfigOps';

vi.mock('./gitConfigOps');

const hub = { name: 'Hub User', email: 'hub@example.com' };

function mockCurrent(name: string, email: string): void {
  vi.mocked(getGitConfigValue).mockImplementation(async (_t, _tr, _p, key) => (key === 'user.name' ? name : email));
}

describe('ensureGitIdentity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns already_set when both are configured', async () => {
    mockCurrent('Test', 'test@test.com');
    expect(await ensureGitIdentity('local', undefined, '/wt', hub)).toEqual({ action: 'already_set' });
    expect(setGitConfigValue).not.toHaveBeenCalled();
  });

  it('applies both when both are missing', async () => {
    mockCurrent('', '');
    expect(await ensureGitIdentity('local', undefined, '/wt', hub)).toEqual({
      action: 'applied',
      fields: [
        { key: 'user.name', value: 'Hub User' },
        { key: 'user.email', value: 'hub@example.com' },
      ],
    });
    expect(setGitConfigValue).toHaveBeenCalledTimes(2);
  });

  it('applies only email when only email is missing', async () => {
    mockCurrent('Test', '');
    expect(await ensureGitIdentity('local', undefined, '/wt', hub)).toEqual({
      action: 'applied',
      fields: [{ key: 'user.email', value: 'hub@example.com' }],
    });
    expect(setGitConfigValue).toHaveBeenCalledTimes(1);
    expect(setGitConfigValue).toHaveBeenCalledWith('local', undefined, '/wt', 'user.email', 'hub@example.com');
  });

  it('applies only name when only name is missing', async () => {
    mockCurrent('', 'test@test.com');
    expect(await ensureGitIdentity('local', undefined, '/wt', hub)).toEqual({
      action: 'applied',
      fields: [{ key: 'user.name', value: 'Hub User' }],
    });
    expect(setGitConfigValue).toHaveBeenCalledTimes(1);
    expect(setGitConfigValue).toHaveBeenCalledWith('local', undefined, '/wt', 'user.name', 'Hub User');
  });

  it('returns hub_missing when missing and hub identity is null', async () => {
    mockCurrent('', '');
    expect(await ensureGitIdentity('local', undefined, '/wt', null)).toEqual({ action: 'hub_missing' });
    expect(setGitConfigValue).not.toHaveBeenCalled();
  });

  it('propagates errors from getGitConfigValue', async () => {
    vi.mocked(getGitConfigValue).mockRejectedValue(new Error('SSH disconnected'));
    await expect(ensureGitIdentity('remote', undefined, '/wt', hub)).rejects.toThrow('SSH disconnected');
    expect(setGitConfigValue).not.toHaveBeenCalled();
  });

  it('propagates errors from setGitConfigValue', async () => {
    mockCurrent('', '');
    vi.mocked(setGitConfigValue).mockRejectedValue(new Error('permission denied'));
    await expect(ensureGitIdentity('local', undefined, '/wt', hub)).rejects.toThrow('permission denied');
  });
});
