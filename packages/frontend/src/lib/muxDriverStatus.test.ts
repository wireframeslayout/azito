import { describe, it, expect } from 'vitest';
import { parseMuxDriverStatus } from './muxDriverStatus';

describe('parseMuxDriverStatus', () => {
  it('is ok when the driver is available', () => {
    expect(parseMuxDriverStatus({ runtime: 'misao', kind: 'misao', driverAvailable: true, caps: {} })).toBe('ok');
  });

  it('maps daemon_unreachable', () => {
    expect(parseMuxDriverStatus({ driverAvailable: false, reason: 'daemon_unreachable' })).toBe('unreachable');
  });

  it('maps protocol_incompatible so the operator sees the cause, not just "cannot connect"', () => {
    expect(parseMuxDriverStatus({ driverAvailable: false, reason: 'protocol_incompatible' })).toBe('incompatible');
  });

  it('maps not_installed: an agent server whose default misao was never installed', () => {
    expect(parseMuxDriverStatus({ driverAvailable: false, reason: 'not_installed' })).toBe('notInstalled');
  });

  it('is unknown for other reasons and malformed bodies', () => {
    expect(parseMuxDriverStatus({ driverAvailable: false, reason: 'driver_not_registered' })).toBe('unknown');
    expect(parseMuxDriverStatus({ driverAvailable: false })).toBe('unknown');
    expect(parseMuxDriverStatus({})).toBe('unknown');
    expect(parseMuxDriverStatus(null)).toBe('unknown');
    expect(parseMuxDriverStatus([])).toBe('unknown');
    expect(parseMuxDriverStatus('x')).toBe('unknown');
  });
});
