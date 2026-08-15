import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeHubCanary, getHubCanary, getVerifiedHubCanary } from './hubCanary';

// Review round (Important finding 2): getHubCanary() used to be the ONLY
// accessor and returned whatever was cached at startup even after the file
// itself was deleted on disk — a same-filesystem agent server would then
// read back "absent" not because it is isolated but because the canary
// itself is gone, letting the FS-boundary check misread that as proof of
// separation. getVerifiedHubCanary() must re-check the file on disk
// immediately before each doctor run and regenerate (or degrade to `null`)
// on mismatch.

describe('hubCanary', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hub-canary-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('writeHubCanary writes a fresh file and getHubCanary/getVerifiedHubCanary both return it', () => {
    const canary = writeHubCanary(dataDir);
    expect(canary).not.toBeNull();
    expect(fs.readFileSync(canary!.path, 'utf-8')).toBe(canary!.content);
    expect(getHubCanary()).toEqual(canary);
    expect(getVerifiedHubCanary()).toEqual(canary);
  });

  it('getVerifiedHubCanary regenerates when the cached canary file has been deleted from disk', () => {
    const original = writeHubCanary(dataDir);
    expect(original).not.toBeNull();
    fs.rmSync(original!.path);

    // getHubCanary (the stale, non-verifying accessor) still returns the
    // now-dangling reference — this is the exact bug this fix closes.
    expect(getHubCanary()).toEqual(original);

    const verified = getVerifiedHubCanary();
    expect(verified).not.toBeNull();
    expect(verified!.path).not.toBe(original!.path); // a genuinely fresh file, not the deleted one
    expect(fs.readFileSync(verified!.path, 'utf-8')).toBe(verified!.content);
  });

  it('getVerifiedHubCanary regenerates when the cached canary file content no longer matches (e.g. clobbered)', () => {
    const original = writeHubCanary(dataDir);
    expect(original).not.toBeNull();
    fs.writeFileSync(original!.path, 'tampered content');

    const verified = getVerifiedHubCanary();
    expect(verified).not.toBeNull();
    expect(fs.readFileSync(verified!.path, 'utf-8')).toBe(verified!.content);
  });

  it('getVerifiedHubCanary returns null (fail-closed, never a stale value) when the data dir itself is gone and cannot be rewritten', () => {
    const original = writeHubCanary(dataDir);
    expect(original).not.toBeNull();
    fs.rmSync(dataDir, { recursive: true, force: true });

    const verified = getVerifiedHubCanary();
    expect(verified).toBeNull();
    expect(getHubCanary()).toBeNull();
  });

  it('getVerifiedHubCanary returns null when the write itself fails (e.g. data dir does not exist)', () => {
    const missingDir = path.join(dataDir, 'does-not-exist');
    const result = writeHubCanary(missingDir);
    expect(result).toBeNull();
    expect(getVerifiedHubCanary()).toBeNull();
  });
});
