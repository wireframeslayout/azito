import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer } from '../semver';

describe('semver comparison', () => {
  it('orders stable versions by major, minor, and patch', () => {
    expect(compareVersions('v0.4.0', 'v0.3.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', 'v0.99.99')).toBeGreaterThan(0);
  });

  it('orders prerelease versions below their stable release', () => {
    expect(compareVersions('v0.4.0', 'v0.4.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('v0.3.0-rc6', 'v0.3.0')).toBeLessThan(0);
  });

  it('compares prerelease identifiers numerically and lexically', () => {
    expect(compareVersions('v0.4.0-rc.10', 'v0.4.0-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.4.0-rc.2', 'v0.4.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('v0.4.0-alpha.1', 'v0.4.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('v0.4.0-beta.1', 'v0.4.0-rc.1')).toBeLessThan(0);
  });

  it('returns equality for identical versions', () => {
    expect(compareVersions('v0.4.0', 'v0.4.0')).toBe(0);
    expect(compareVersions('v0.4.0-rc.1', 'v0.4.0-rc.1')).toBe(0);
  });

  it('reports whether a candidate is newer', () => {
    expect(isNewer('v0.4.0', 'v0.3.0')).toBe(true);
    expect(isNewer('v0.4.0-rc.1', 'v0.4.0')).toBe(false);
    expect(isNewer('v0.4.0', 'v0.4.0')).toBe(false);
  });
});
