import { describe, expect, it } from 'vitest';
import { signUrlToken, verifyUrlToken } from './signedUrl';

describe('signed URL tokens', () => {
  it('binds the target, scope, expiry and key', () => {
    const key = Buffer.alloc(32, 1);
    const token = signUrlToken(key, 'media', 'project:1/file', 100);
    expect(verifyUrlToken(key, token, 'media', 99)).toBe('project:1/file');
    expect(verifyUrlToken(key, token, 'media', 100)).toBeNull();
    expect(verifyUrlToken(key, token, 'wopi', 99)).toBeNull();
    expect(verifyUrlToken(Buffer.alloc(32, 2), token, 'media', 99)).toBeNull();
    expect(verifyUrlToken(key, token + 'x', 'media', 99)).toBeNull();
  });
});
