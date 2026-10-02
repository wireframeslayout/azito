import { describe, it, expect } from 'vitest';
import { parseMuxDriverStatus } from './muxDriverStatus';

describe('parseMuxDriverStatus', () => {
  it('is ok when the driver is available', () => {
    expect(parseMuxDriverStatus({ runtime: 'misao', kind: 'misao', driverAvailable: true, caps: {} })).toBe('ok');
  });

  it('maps daemon_unreachable and misao_disabled', () => {
    expect(parseMuxDriverStatus({ driverAvailable: false, reason: 'daemon_unreachable' })).toBe('unreachable');
    expect(parseMuxDriverStatus({ driverAvailable: false, reason: 'misao_disabled' })).toBe('disabled');
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
