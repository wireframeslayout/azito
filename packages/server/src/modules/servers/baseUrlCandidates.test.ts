import { describe, it, expect } from 'vitest';
import { buildBaseUrlCandidates } from './baseUrlCandidates';

describe('buildBaseUrlCandidates', () => {
  it('prepends Public URL when AZITO_PUBLIC_URL is set', () => {
    const result = buildBaseUrlCandidates(
      'https://server001.tail8bef04.ts.net',
      'server001.tail8bef04.ts.net',
      '100.64.0.1',
      ['192.168.1.10'],
      '3001',
    );
    expect(result[0]).toEqual({ label: 'Public URL', url: 'https://server001.tail8bef04.ts.net' });
    expect(result.length).toBe(4);
  });

  it('returns only network candidates when publicUrl is undefined', () => {
    const result = buildBaseUrlCandidates(undefined, 'host.ts.net', '100.64.0.1', ['192.168.1.10'], '3001');
    expect(result).toEqual([
      { label: 'Tailscale (DNS)', url: 'http://host.ts.net:3001' },
      { label: 'Tailscale (IP)', url: 'http://100.64.0.1:3001' },
      { label: 'LAN (192.168.1.10)', url: 'http://192.168.1.10:3001' },
    ]);
  });

  it('deduplicates when Public URL matches a Tailscale DNS candidate', () => {
    const result = buildBaseUrlCandidates(
      'http://host.ts.net:3001',
      'host.ts.net',
      '100.64.0.1',
      [],
      '3001',
    );
    expect(result).toEqual([
      { label: 'Public URL', url: 'http://host.ts.net:3001' },
      { label: 'Tailscale (IP)', url: 'http://100.64.0.1:3001' },
    ]);
  });

  it('normalises trailing slash for deduplication', () => {
    const result = buildBaseUrlCandidates(
      'http://host.ts.net:3001/',
      'host.ts.net',
      null,
      [],
      '3001',
    );
    expect(result).toEqual([
      { label: 'Public URL', url: 'http://host.ts.net:3001' },
    ]);
  });

  it('returns empty array when all inputs are null/empty', () => {
    expect(buildBaseUrlCandidates(undefined, null, null, [], '3001')).toEqual([]);
  });

  it('returns only Public URL when no network info is available', () => {
    const result = buildBaseUrlCandidates('https://my-hub.example.com', null, null, [], '3001');
    expect(result).toEqual([{ label: 'Public URL', url: 'https://my-hub.example.com' }]);
  });

  it('includes multiple LAN IPs', () => {
    const result = buildBaseUrlCandidates(undefined, null, null, ['192.168.1.10', '10.0.0.5'], '3001');
    expect(result).toEqual([
      { label: 'LAN (192.168.1.10)', url: 'http://192.168.1.10:3001' },
      { label: 'LAN (10.0.0.5)', url: 'http://10.0.0.5:3001' },
    ]);
  });
});
