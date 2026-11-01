import { describe, expect, it } from 'vitest';
import { diagnoseLocalNetworkError, LocalNetworkPermissionError, isPossibleLocalNetworkPermission as diagnose } from './localNetworkDiagnosis';

describe('local network diagnosis', () => {
  it.each(['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '169.254.255.255', 'fc00::', 'fdff::1', 'fe80::1%en0', 'febf::1', '::ffff:192.168.1.1', '0:0:0:0:0:ffff:c0a8:101'])('recognizes %s', (ip) => {
    expect(diagnose('darwin', true, ip, 'EHOSTUNREACH')).toBe(true);
  });
  it.each(['172.15.255.255', '172.32.0.0', '100.64.0.1', '8.8.8.8', 'fe7f::1', 'fec0::1', 'invalid'])('excludes %s', (ip) => {
    expect(diagnose('darwin', true, ip, 'ENETUNREACH')).toBe(false);
  });
  it('requires macOS, launchd, address and an unreachable errno', () => {
    expect(diagnose('linux', true, '10.0.0.1', 'EHOSTUNREACH')).toBe(false);
    expect(diagnose('win32', true, '10.0.0.1', 'EHOSTUNREACH')).toBe(false);
    expect(diagnose('darwin', false, '10.0.0.1', 'EHOSTUNREACH')).toBe(false);
    expect(diagnose('darwin', true, undefined, 'EHOSTUNREACH')).toBe(false);
    expect(diagnose('darwin', true, '10.0.0.1', 'ECONNREFUSED')).toBe(false);
  });
});

describe('diagnosing socket errors', () => {
  it('retains the socket detail from a nested cause', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.2:22'), { code: 'EHOSTUNREACH', address: '192.168.1.2' });
    const error = new Error('fetch failed', { cause });
    expect(diagnoseLocalNetworkError(error, 'darwin', true)).toEqual(new LocalNetworkPermissionError(cause.message));
    expect(diagnoseLocalNetworkError(error, 'darwin', false)).toBe(error);
  });
});
