import { describe, expect, it } from 'vitest';
import { errorMessageOf } from './apiResult';

describe('errorMessageOf', () => {
  it('returns null for a success body', () => {
    expect(errorMessageOf({ ok: true })).toBeNull();
    expect(errorMessageOf(null)).toBeNull();
    expect(errorMessageOf('ok')).toBeNull();
  });
  it('prefers message over error', () => {
    expect(errorMessageOf({ error: 'mux_driver_unavailable' })).toBe('mux_driver_unavailable');
    expect(errorMessageOf({ error: 'x', message: 'readable' })).toBe('readable');
  });
});
