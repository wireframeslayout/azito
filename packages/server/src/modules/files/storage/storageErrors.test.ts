import { describe, expect, it } from 'vitest';
import { classifyStorageError } from './storageErrors';

describe('storage error classification', () => {
  it.each([
    ['ENOTFOUND', 'dns'], ['ECONNREFUSED', 'refused'], ['ETIMEDOUT', 'timeout'],
    ['AbortError', 'timeout'], ['AccessDenied', 'auth'], ['NoSuchBucket', 'bucket'], ['other', 'unknown'],
  ])('classifies %s as %s without leaking details', (code, expected) => {
    const result = classifyStorageError({ code, message: 'secret' });
    expect(result.code).toBe(expected);
    expect(result.error).not.toContain('secret');
  });
});
