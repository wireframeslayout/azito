import { describe, expect, it } from 'vitest';
import { measureHostResources, parseHostResourceSample, systemDriveOf, type HostResourceSource } from './hostResources';

const source = (overrides: Partial<HostResourceSource> = {}): HostResourceSource => ({
  totalmem: () => 16_000,
  freemem: () => 4_000,
  statfs: async () => ({ bsize: 4, blocks: 100, bfree: 25 }),
  ...overrides,
});

describe('measureHostResources', () => {
  it('reads memory from os and the disk from statfs', async () => {
    expect(await measureHostResources('C:\\', source())).toEqual({
      memTotalBytes: 16_000,
      memAvailableBytes: 4_000,
      disk: { usedBytes: 300, totalBytes: 400 },
    });
  });

  it('leaves the disk null when no drive is named or it cannot be read', async () => {
    expect((await measureHostResources(null, source())).disk).toBeNull();
    expect((await measureHostResources('C:\\', source({ statfs: async () => { throw new Error('EPERM'); } }))).disk).toBeNull();
  });

  it('rejects memory that cannot be read instead of reporting zero', async () => {
    await expect(measureHostResources(null, source({ totalmem: () => 0 }))).rejects.toThrow();
  });
});

describe('systemDriveOf', () => {
  it('is the drive of the Windows system folder', () => {
    expect(systemDriveOf('C:\\Windows')).toBe('C:\\');
    expect(systemDriveOf('D:\\WINNT')).toBe('D:\\');
  });
  it('is null when the host names none', () => {
    expect(systemDriveOf(undefined)).toBeNull();
    expect(systemDriveOf('')).toBeNull();
  });
});

describe('parseHostResourceSample', () => {
  it('refuses a body of another shape', () => {
    expect(() => parseHostResourceSample({ memTotalBytes: 1 })).toThrow();
  });
});
