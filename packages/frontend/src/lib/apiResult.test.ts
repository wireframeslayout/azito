import { describe, expect, it } from 'vitest';
import { errorMessageOf } from './apiResult';

describe('errorMessageOf', () => {
  it('returns null for null and undefined', () => {
    expect(errorMessageOf(null)).toBeNull();
    expect(errorMessageOf(undefined)).toBeNull();
  });

  it('returns null for a success body', () => {
    expect(errorMessageOf({ ok: true })).toBeNull();
  });

  it('returns null for a string body', () => {
    expect(errorMessageOf('not_found')).toBeNull();
  });

  it('returns the error code when there is no message', () => {
    expect(errorMessageOf({ error: 'not_found' })).toBe('not_found');
  });

  it('prefers the message over the error code', () => {
    expect(errorMessageOf({ error: 'not_found', message: 'Resource not found' })).toBe('Resource not found');
  });

  it('falls back to the error code for an empty message', () => {
    expect(errorMessageOf({ error: 'err', message: '' })).toBe('err');
  });

  it('returns null when the body has no error field', () => {
    expect(errorMessageOf({ other: 'field' })).toBeNull();
  });
});
