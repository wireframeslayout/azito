import { describe, expect, it } from 'vitest';
import { DeadlineExceededError, raceDeadline } from './deadline';

describe('raceDeadline', () => {
  it('returns the result of an operation that finishes in time, and its own failure', async () => {
    await expect(raceDeadline(Promise.resolve(5), Date.now() + 1_000, 'op')).resolves.toBe(5);
    await expect(raceDeadline(Promise.reject(new Error('boom')), Date.now() + 1_000, 'op')).rejects.toThrow('boom');
  });

  it('fails with DeadlineExceededError when the deadline comes first, or has already passed', async () => {
    await expect(raceDeadline(new Promise(() => undefined), Date.now() + 20, 'The walk')).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(raceDeadline(Promise.resolve(1), Date.now() - 1, 'The walk')).rejects.toThrow('The walk ran past its deadline');
  });
});
