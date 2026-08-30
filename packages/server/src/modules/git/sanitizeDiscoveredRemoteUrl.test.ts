import { describe, it, expect } from 'vitest';
import { sanitizeDiscoveredRemoteUrl } from './sanitizeDiscoveredRemoteUrl';

describe('sanitizeDiscoveredRemoteUrl', () => {
  it('keeps scp-like SSH syntax unchanged, including the conventional git user', () => {
    expect(sanitizeDiscoveredRemoteUrl('git@github.com:acme/widgets.git')).toBe(
      'git@github.com:acme/widgets.git',
    );
  });

  it('strips only the password from a password-carrying scp-like remote, keeping the username', () => {
    expect(sanitizeDiscoveredRemoteUrl('user:dummy-secret@example.com:acme/widgets.git')).toBe(
      'user@example.com:acme/widgets.git',
    );
  });

  it('keeps ssh:// URLs with only a username unchanged', () => {
    expect(sanitizeDiscoveredRemoteUrl('ssh://git@example.com:2222/acme/widgets.git')).toBe(
      'ssh://git@example.com:2222/acme/widgets.git',
    );
  });

  it('strips password/query/fragment from an ssh:// URL but keeps the username', () => {
    expect(
      sanitizeDiscoveredRemoteUrl('ssh://user:dummy-secret@example.com:22/acme/widgets.git?x=1#y=2'),
    ).toBe('ssh://user@example.com:22/acme/widgets.git');
  });

  it('keeps a local filesystem path remote unchanged', () => {
    expect(sanitizeDiscoveredRemoteUrl('/srv/repos/widgets.git')).toBe('/srv/repos/widgets.git');
  });

  it('keeps a relative path remote unchanged', () => {
    expect(sanitizeDiscoveredRemoteUrl('../widgets.git')).toBe('../widgets.git');
  });

  it('strips a user:token@ credential from an https URL, keeping it clone-able', () => {
    expect(
      sanitizeDiscoveredRemoteUrl('https://user:dummy-token@github.com/acme/widgets.git'),
    ).toBe('https://github.com/acme/widgets.git');
  });

  it('strips a bare token-as-username credential from an https URL', () => {
    expect(sanitizeDiscoveredRemoteUrl('https://ghp_dummytoken@github.com/acme/widgets.git')).toBe(
      'https://github.com/acme/widgets.git',
    );
  });

  it('leaves a plain https URL unchanged', () => {
    expect(sanitizeDiscoveredRemoteUrl('https://github.com/acme/widgets.git')).toBe(
      'https://github.com/acme/widgets.git',
    );
  });

  it('strips a credential carried only in the query string of an https URL', () => {
    expect(
      sanitizeDiscoveredRemoteUrl('https://github.com/acme/widgets.git?token=dummy-token'),
    ).toBe('https://github.com/acme/widgets.git');
  });

  it('strips a credential carried only in the fragment of an https URL', () => {
    expect(
      sanitizeDiscoveredRemoteUrl('https://github.com/acme/widgets.git#access_token=dummy-token'),
    ).toBe('https://github.com/acme/widgets.git');
  });

  it('strips userinfo, query, and fragment together from an https URL', () => {
    expect(
      sanitizeDiscoveredRemoteUrl(
        'https://user:dummy-token@github.com/acme/widgets.git?x=1#y=2',
      ),
    ).toBe('https://github.com/acme/widgets.git');
  });

  it('drops a harmless query string even with no credential present', () => {
    expect(sanitizeDiscoveredRemoteUrl('https://github.com/acme/widgets.git?ref=main')).toBe(
      'https://github.com/acme/widgets.git',
    );
  });

  it('does not mistake a scp-like SSH remote for having a query string', () => {
    // Regression guard: `git@host:owner/repo.git?x=1` has no URL scheme, so
    // the `?x=1` here is part of the (unusual but valid) SCP-like path, not
    // a query string to strip.
    expect(sanitizeDiscoveredRemoteUrl('git@github.com:acme/widgets.git?x=1')).toBe(
      'git@github.com:acme/widgets.git?x=1',
    );
  });

  it('returns null (not a placeholder string) for a structurally malformed http(s)-scheme value', () => {
    const result = sanitizeDiscoveredRemoteUrl('https://[bad');
    expect(result).toBeNull();
  });

  it('returns null for a structurally malformed scheme:// value that is not http(s)', () => {
    const result = sanitizeDiscoveredRemoteUrl('ssh://[bad');
    expect(result).toBeNull();
  });
});
