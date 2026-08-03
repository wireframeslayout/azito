import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../i18n', () => ({ default: { language: 'en' } }));

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats recent time differently for en and ja', async () => {
    const { formatRelativeTime } = await import('./time');
    const now = Date.now();
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString().replace('Z', '').split('.')[0];

    const enResult = formatRelativeTime(fiveMinAgo, 'en');
    const jaResult = formatRelativeTime(fiveMinAgo, 'ja');

    expect(enResult).not.toBe(jaResult);
    expect(typeof enResult).toBe('string');
    expect(typeof jaResult).toBe('string');
    expect(enResult.length).toBeGreaterThan(0);
    expect(jaResult.length).toBeGreaterThan(0);
  });

  it('formats hours ago', async () => {
    const { formatRelativeTime } = await import('./time');
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString().replace('Z', '').split('.')[0];

    const enResult = formatRelativeTime(twoHoursAgo, 'en');
    expect(enResult).toMatch(/2/);
  });

  it('formats days ago', async () => {
    const { formatRelativeTime } = await import('./time');
    const now = Date.now();
    const threeDaysAgo = new Date(now - 3 * 86400 * 1000).toISOString().replace('Z', '').split('.')[0];

    const enResult = formatRelativeTime(threeDaysAgo, 'en');
    expect(enResult).toMatch(/3/);
  });

  it('formats just now for very recent times', async () => {
    const { formatRelativeTime } = await import('./time');
    const now = new Date(Date.now() - 5000).toISOString().replace('Z', '').split('.')[0];

    const enResult = formatRelativeTime(now, 'en');
    expect(typeof enResult).toBe('string');
    expect(enResult.length).toBeGreaterThan(0);
  });

  it('parses a trailing-Z ISO string without crashing', async () => {
    const { formatRelativeTime } = await import('./time');
    const twoHoursAgoIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const result = formatRelativeTime(twoHoursAgoIso, 'en');
    expect(() => formatRelativeTime(twoHoursAgoIso, 'en')).not.toThrow();
    expect(result).toMatch(/2/);
  });

  it('parses an ISO string with a +09:00 offset (git commit date format)', async () => {
    const { formatRelativeTime } = await import('./time');
    // 2 hours before "now", expressed in JST (+09:00) rather than UTC.
    const jstDate = new Date(Date.now() - 2 * 3600 * 1000);
    const jstOffsetMs = jstDate.getTime() + 9 * 3600 * 1000;
    const jst = new Date(jstOffsetMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const isoWithOffset = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;

    const result = formatRelativeTime(isoWithOffset, 'en');
    expect(() => formatRelativeTime(isoWithOffset, 'en')).not.toThrow();
    expect(result).toMatch(/2/);
  });

  it('keeps naive "YYYY-MM-DD HH:MM:SS" SQLite datetimes interpreted as UTC', async () => {
    const { formatRelativeTime } = await import('./time');
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const naive = `${twoHoursAgo.getUTCFullYear()}-${pad(twoHoursAgo.getUTCMonth() + 1)}-${pad(twoHoursAgo.getUTCDate())} ${pad(twoHoursAgo.getUTCHours())}:${pad(twoHoursAgo.getUTCMinutes())}:${pad(twoHoursAgo.getUTCSeconds())}`;

    const result = formatRelativeTime(naive, 'en');
    expect(result).toMatch(/2/);
  });

  it('accepts a number (ms since epoch) input', async () => {
    const { formatRelativeTime } = await import('./time');
    const twoHoursAgoMs = Date.now() - 2 * 3600 * 1000;

    const result = formatRelativeTime(twoHoursAgoMs, 'en');
    expect(result).toMatch(/2/);
  });

  it('accepts a Date object input', async () => {
    const { formatRelativeTime } = await import('./time');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);

    const result = formatRelativeTime(twoHoursAgo, 'en');
    expect(result).toMatch(/2/);
  });

  it('returns an empty string instead of throwing for an invalid date string', async () => {
    const { formatRelativeTime } = await import('./time');

    expect(() => formatRelativeTime('not-a-date', 'en')).not.toThrow();
    expect(formatRelativeTime('not-a-date', 'en')).toBe('');
  });
});
