import { describe, it, expect } from 'vitest';
import { createTokenVerifier } from './tokenAuth';

describe('createTokenVerifier', () => {
  const verify = createTokenVerifier('my-secret-token');

  it('should accept valid Bearer token', () => {
    expect(verify('Bearer my-secret-token')).toBe(true);
  });

  it('should reject missing header', () => {
    expect(verify(undefined)).toBe(false);
  });

  it('should reject empty string', () => {
    expect(verify('')).toBe(false);
  });

  it('should reject wrong token', () => {
    expect(verify('Bearer wrong-token-here')).toBe(false);
  });

  it('should reject token without Bearer prefix', () => {
    expect(verify('my-secret-token')).toBe(false);
  });

  it('should reject Basic auth scheme', () => {
    expect(verify('Basic my-secret-token')).toBe(false);
  });

  it('should reject token with different length', () => {
    expect(verify('Bearer short')).toBe(false);
  });

  it('should reject token with extra spaces', () => {
    expect(verify('Bearer  my-secret-token')).toBe(false);
  });
});
