import { describe, it, expect } from 'vitest';
import { sanitizeDiscoveredRemoteUrl } from './sanitizeDiscoveredRemoteUrl';

describe('sanitizeDiscoveredRemoteUrl', () => {
  it('keeps scp-like SSH syntax unchanged, including the conventional git user', () => {
    expect(sanitizeDiscoveredRemoteUrl('git@github.com:acme/widgets.git')).toBe(
      'git@github.com:acme/widgets.git',
    );
  });

  it('keeps ssh:// URLs unchanged, including the conventional git user', () => {
    expect(sanitizeDiscoveredRemoteUrl('ssh://git@example.com:2222/acme/widgets.git')).toBe(
      'ssh://git@example.com:2222/acme/widgets.git',
    );
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
});
