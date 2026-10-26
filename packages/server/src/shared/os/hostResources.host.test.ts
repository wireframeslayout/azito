import { describe, expect, it } from 'vitest';
import os from 'os';
import { measureHostResources } from './hostResources';

/** The real machine the tests run on (Linux, macOS and the Windows CI runner): memory and the disk of the drive holding the temp folder are plain numbers. */
describe('the resources of this host', () => {
  it('are numbers from Node, with a disk that adds up', async () => {
    const sample = await measureHostResources(os.tmpdir());
    expect(sample.memTotalBytes).toBeGreaterThan(0);
    expect(sample.memAvailableBytes).toBeGreaterThanOrEqual(0);
    expect(sample.memAvailableBytes).toBeLessThanOrEqual(sample.memTotalBytes);
    expect(sample.disk).not.toBeNull();
    expect(sample.disk!.usedBytes).toBeLessThanOrEqual(sample.disk!.totalBytes);
  });
});
