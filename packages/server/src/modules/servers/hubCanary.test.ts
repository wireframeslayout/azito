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

  // Review round (Nit): every regeneration previously left the old canary
  // file behind forever, so a long-lived hub restarting (or re-verifying)
  // repeatedly would accumulate `.azito-hub-canary-*` files without bound.
  describe('stale canary cleanup', () => {
    it('removes the previous canary file when writeHubCanary regenerates', () => {
      const first = writeHubCanary(dataDir);
      expect(first).not.toBeNull();
      expect(fs.existsSync(first!.path)).toBe(true);

      const second = writeHubCanary(dataDir);
      expect(second).not.toBeNull();
      expect(second!.path).not.toBe(first!.path);
      expect(fs.existsSync(first!.path)).toBe(false);
      expect(fs.existsSync(second!.path)).toBe(true);
    });

    it('removes ALL stale canary files, not just the immediately preceding one', () => {
      // Simulate several past regenerations without cleanup ever having run
      // (e.g. files left over from a version predating this fix).
      fs.writeFileSync(path.join(dataDir, '.azito-hub-canary-aaaa'), 'stale-1');
      fs.writeFileSync(path.join(dataDir, '.azito-hub-canary-bbbb'), 'stale-2');
      fs.writeFileSync(path.join(dataDir, '.azito-hub-canary-cccc'), 'stale-3');

      const fresh = writeHubCanary(dataDir);
      expect(fresh).not.toBeNull();

      const remaining = fs.readdirSync(dataDir).filter((n) => n.startsWith('.azito-hub-canary-'));
      expect(remaining).toEqual([path.basename(fresh!.path)]);
    });

    it('does not touch unrelated files in the data directory', () => {
      const unrelatedPath = path.join(dataDir, 'data.db');
      fs.writeFileSync(unrelatedPath, 'not-a-canary');

      writeHubCanary(dataDir);
      writeHubCanary(dataDir); // second regeneration, to also exercise the cleanup path

      expect(fs.existsSync(unrelatedPath)).toBe(true);
      expect(fs.readFileSync(unrelatedPath, 'utf-8')).toBe('not-a-canary');
    });

    it('cleanup after a getVerifiedHubCanary-triggered regeneration also removes the stale file', () => {
      const original = writeHubCanary(dataDir);
      expect(original).not.toBeNull();
      fs.rmSync(original!.path); // simulate deletion, forcing getVerifiedHubCanary to rewrite

      const verified = getVerifiedHubCanary();
      expect(verified).not.toBeNull();

      const remaining = fs.readdirSync(dataDir).filter((n) => n.startsWith('.azito-hub-canary-'));
      expect(remaining).toEqual([path.basename(verified!.path)]);
    });
  });
});
