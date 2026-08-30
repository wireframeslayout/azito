import { describe, it, expect } from 'vitest';
import { urlHasEmbeddedCredentials } from './urlHasEmbeddedCredentials';

describe('urlHasEmbeddedCredentials', () => {
  it('detects a user:token@ pattern in an https URL', () => {
    expect(urlHasEmbeddedCredentials('https://user:dummy-token@github.com/acme/widgets.git')).toBe(true);
  });

  it('detects a bare token-as-username in an https URL', () => {
    expect(urlHasEmbeddedCredentials('https://ghp_dummytoken@github.com/acme/widgets.git')).toBe(true);
  });

  it('does not flag a plain https URL', () => {
    expect(urlHasEmbeddedCredentials('https://github.com/acme/widgets.git')).toBe(false);
  });

  it('does not flag an ssh:// URL with a conventional account username', () => {
    expect(urlHasEmbeddedCredentials('ssh://git@example.com:2222/acme/widgets.git')).toBe(false);
  });

  it('does not flag scp-like syntax', () => {
    expect(urlHasEmbeddedCredentials('git@github.com:acme/widgets.git')).toBe(false);
  });

  it('does not flag an unparseable value', () => {
    expect(urlHasEmbeddedCredentials('not a url')).toBe(false);
  });
});
