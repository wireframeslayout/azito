import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findAzitoctlEnvFiles } from './azitoctlEnv';

describe('findAzitoctlEnvFiles', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'azitoctl-env-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns [] when ~/.azito does not exist', () => {
    expect(findAzitoctlEnvFiles()).toEqual([]);
  });

  it('finds the unprefixed azitoctl.env', () => {
    const dir = path.join(fakeHome, '.azito');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'azitoctl.env'), '');

    expect(findAzitoctlEnvFiles()).toEqual([path.join(dir, 'azitoctl.env')]);
  });

  it('finds a simple-prefixed azitoctl-<prefix>.env', () => {
    const dir = path.join(fakeHome, '.azito');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'azitoctl-prod.env'), '');

    expect(findAzitoctlEnvFiles()).toEqual([path.join(dir, 'azitoctl-prod.env')]);
  });

  // Phase C round-4 review (Important finding): harness/setup.sh's --prefix
  // accepts any string (no charset restriction — see its --prefix/--prefix=*
  // parsing), so `--prefix prod.eu` legitimately produces
  // `azitoctl-prod.eu.env`. The old discovery regex's prefix group was
  // `[^.]+` (no dots allowed), so this exact file was silently skipped by
  // both `azito auth doctor` and `azito token rotate` — a doctor run against
  // a dotted-prefix environment could report clean while a stale UI token
  // lingered in a file it never even looked at.
  it('finds a DOTTED-prefix azitoctl-<prefix>.env (regression: --prefix has no charset restriction)', () => {
    const dir = path.join(fakeHome, '.azito');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'azitoctl-prod.eu.env'), '');

    expect(findAzitoctlEnvFiles()).toEqual([path.join(dir, 'azitoctl-prod.eu.env')]);
  });

  it('finds multiple azitoctl*.env files, including a mix of unprefixed, simple, and dotted prefixes', () => {
    const dir = path.join(fakeHome, '.azito');
    fs.mkdirSync(dir, { recursive: true });
    const names = ['azitoctl.env', 'azitoctl-prod.env', 'azitoctl-prod.eu.env', 'azitoctl-a.b.c.env'];
    for (const name of names) fs.writeFileSync(path.join(dir, name), '');

    const found = findAzitoctlEnvFiles().map((f) => path.basename(f)).sort();
    expect(found).toEqual([...names].sort());
  });

  it('does not match unrelated files in ~/.azito', () => {
    const dir = path.join(fakeHome, '.azito');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'azitoctl.env.bak'), '');
    fs.writeFileSync(path.join(dir, 'operator.env'), '');
    fs.writeFileSync(path.join(dir, 'not-azitoctl.env'), '');

    expect(findAzitoctlEnvFiles()).toEqual([]);
  });
});
