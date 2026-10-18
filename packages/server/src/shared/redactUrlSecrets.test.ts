import { describe, expect, it } from 'vitest';
import { redactUrlSecrets } from './redactUrlSecrets';

describe('redactUrlSecrets', () => {
  it('redacts the token value and keeps other params', () => {
    expect(redactUrlSecrets('/ws?server=local&token=abc123')).toBe('/ws?server=local&token=[REDACTED]');
  });

  it('leaves urls without a secret key unchanged', () => {
    expect(redactUrlSecrets('/ws?mode=events')).toBe('/ws?mode=events');
  });

  it('redacts every duplicated token', () => {
    expect(redactUrlSecrets('/ws?token=abc&cols=80&token=def')).toBe('/ws?token=[REDACTED]&cols=80&token=[REDACTED]');
  });

  it('leaves urls without a query unchanged', () => {
    expect(redactUrlSecrets('/api/health')).toBe('/api/health');
  });

  it('returns an empty string as is', () => {
    expect(redactUrlSecrets('')).toBe('');
  });

  it('redacts an empty token value', () => {
    expect(redactUrlSecrets('/ws?token=')).toBe('/ws?token=[REDACTED]');
  });

  it('redacts a percent-encoded token value', () => {
    expect(redactUrlSecrets('/ws?token=a%20b')).toBe('/ws?token=[REDACTED]');
  });

  it('redacts a token key without a value', () => {
    expect(redactUrlSecrets('/ws?token')).toBe('/ws?token=[REDACTED]');
  });

  it('does not throw on a malformed escape', () => {
    expect(redactUrlSecrets('/ws?%E0%A4%A=1&token=x')).toBe('/ws?%E0%A4%A=1&token=[REDACTED]');
  });
});
