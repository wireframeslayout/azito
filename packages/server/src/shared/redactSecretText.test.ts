import { describe, expect, it } from 'vitest';
import { redactSecretText } from './redactSecretText';

describe('redactSecretText', () => {
  it('hides the value of an assignment to a secret-looking name (sh, cmd, PowerShell forms)', () => {
    expect(redactSecretText('export AZITO_TOKEN=abc123')).toBe('export AZITO_TOKEN=[REDACTED]');
    expect(redactSecretText('set API_KEY=abc123')).toBe('set API_KEY=[REDACTED]');
    expect(redactSecretText("$env:DB_PASSWORD = 'p w d'")).toBe('$env:DB_PASSWORD = [REDACTED]');
    expect(redactSecretText('client_secret: "x y"')).toBe('client_secret: [REDACTED]');
  });

  it('hides a Bearer value and token-shaped strings', () => {
    expect(redactSecretText('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSecretText('using ghp_abcdefghijklmnopqrstuvwxyz0123456789 now')).toBe('using [REDACTED] now');
    expect(redactSecretText(`hash ${'a1'.repeat(20)}`)).toBe('hash [REDACTED]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'sh: 1: boom: not found\nGet-CimInstance : failed (exit code 1)';
    expect(redactSecretText(text)).toBe(text);
  });
});
