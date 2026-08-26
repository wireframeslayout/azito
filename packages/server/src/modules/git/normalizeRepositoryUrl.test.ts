import { describe, it, expect } from 'vitest';
import { normalizeRepositoryUrlToHttps } from './normalizeRepositoryUrl';

describe('normalizeRepositoryUrlToHttps', () => {
  it('passes through an already-https URL, stripping a trailing slash', () => {
    expect(normalizeRepositoryUrlToHttps('https://github.com/wireframeslayout/azito.git')).toBe(
      'https://github.com/wireframeslayout/azito.git',
    );
    expect(normalizeRepositoryUrlToHttps('https://github.com/wireframeslayout/azito/')).toBe(
      'https://github.com/wireframeslayout/azito',
    );
  });

  // Issue #29 Step 3b review, Important finding 2: this function's only
  // caller pins a CREDENTIAL-BEARING push URL — an `http://` pin would leak
  // AZITO_PUSH_TOKEN in cleartext on the wire, so http: is rejected (null),
  // never downgraded-and-accepted.
  it('rejects an http URL (would leak the push credential in cleartext)', () => {
    expect(normalizeRepositoryUrlToHttps('http://gitlab.internal/team/repo.git')).toBeNull();
  });

  it('converts scp-like syntax (git@host:owner/repo.git) to https', () => {
    expect(normalizeRepositoryUrlToHttps('git@github.com:wireframeslayout/azito.git')).toBe(
      'https://github.com/wireframeslayout/azito.git',
    );
  });

  it('converts scp-like syntax without a .git suffix', () => {
    expect(normalizeRepositoryUrlToHttps('git@github.com:wireframeslayout/azito')).toBe(
      'https://github.com/wireframeslayout/azito.git',
    );
  });

  it('converts ssh:// URLs (with explicit port) to https', () => {
    expect(normalizeRepositoryUrlToHttps('ssh://git@gitlab.example.com:2222/team/repo.git')).toBe(
      'https://gitlab.example.com/team/repo.git',
    );
  });

  it('converts ssh:// URLs without a user@ prefix', () => {
    expect(normalizeRepositoryUrlToHttps('ssh://gitlab.example.com/team/repo')).toBe(
      'https://gitlab.example.com/team/repo.git',
    );
  });

  it('returns null for an empty or whitespace-only input', () => {
    expect(normalizeRepositoryUrlToHttps('')).toBeNull();
    expect(normalizeRepositoryUrlToHttps('   ')).toBeNull();
  });

  it('returns null for an unsupported scheme (git://, file://)', () => {
    expect(normalizeRepositoryUrlToHttps('git://github.com/wireframeslayout/azito.git')).toBeNull();
    expect(normalizeRepositoryUrlToHttps('file:///home/user/repo')).toBeNull();
  });

  it('returns null for garbage input that matches no known form', () => {
    expect(normalizeRepositoryUrlToHttps('not a url at all')).toBeNull();
    expect(normalizeRepositoryUrlToHttps('just-a-hostname-no-path')).toBeNull();
  });

  // Issue #29 Step 3b review, Minor finding 4: an uppercase scheme/host must
  // normalize to lowercase, because push.sh's credential helper compares
  // the AZITO_PUSH_URL's host/path against git's credential protocol
  // request, whose `host=`/`protocol=` values are always lowercase — a
  // mixed-case URL that passed through unmodified would never match, and
  // the credential would be silently withheld for an otherwise-valid URL.
  it('lowercases an uppercase scheme and host, but preserves the path as-is', () => {
    expect(normalizeRepositoryUrlToHttps('HTTPS://GitHub.com/WireframesLayout/Azito.git')).toBe(
      'https://github.com/WireframesLayout/Azito.git',
    );
  });

  it('rejects a mixed-case http scheme too (still http:, not https:)', () => {
    expect(normalizeRepositoryUrlToHttps('Http://GitLab.Internal/team/repo.git')).toBeNull();
  });

  // Issue #29 Step 3b review, Minor finding 6: scp-like/ssh:// hosts must
  // also be lowercased — push.sh's credential helper's host comparison is
  // case-sensitive against git's always-lowercase `host=` credential
  // request.
  it('lowercases an uppercase host from scp-like syntax', () => {
    expect(normalizeRepositoryUrlToHttps('git@GitHub.com:WireframesLayout/Azito.git')).toBe(
      'https://github.com/WireframesLayout/Azito.git',
    );
  });

  it('lowercases an uppercase host from an ssh:// URL', () => {
    expect(normalizeRepositoryUrlToHttps('ssh://git@GitLab.Example.com:2222/team/repo.git')).toBe(
      'https://gitlab.example.com/team/repo.git',
    );
  });

  // Issue #29 Step 3b review, finding 5: a root or single-segment path can
  // never match push.sh's credential helper (which compares the full
  // `owner/repo` path) — it must fail closed (null), not normalize into a
  // pin the helper can never authenticate against.
  it('rejects an https URL with a root or single-segment path (no owner/repo)', () => {
    expect(normalizeRepositoryUrlToHttps('https://github.com')).toBeNull();
    expect(normalizeRepositoryUrlToHttps('https://github.com/')).toBeNull();
    expect(normalizeRepositoryUrlToHttps('https://github.com/wireframeslayout')).toBeNull();
  });

  it('rejects scp-like/ssh:// input with a single path component (no owner/repo)', () => {
    expect(normalizeRepositoryUrlToHttps('git@github.com:wireframeslayout')).toBeNull();
    expect(normalizeRepositoryUrlToHttps('ssh://git@gitlab.example.com/team')).toBeNull();
  });

  it('never throws on malformed input', () => {
    expect(() => normalizeRepositoryUrlToHttps('https://')).not.toThrow();
    expect(() => normalizeRepositoryUrlToHttps(':::')).not.toThrow();
  });
});
