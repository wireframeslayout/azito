import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

// Regression coverage for Issue #87 review, Important finding 2: making
// clone() async reopened a race the old synchronous implementation happened
// to close by accident — two concurrent requests for the SAME target could
// both pass assertTargetEmpty() before either one's `git clone` had created
// anything. Never touches a real remote (throwaway local git repos under the
// OS tmp dir), matching LocalRepoCloneService.test.ts's own convention.

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

function createOriginRepo(dir: string, branch: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(['init', '-q', `--initial-branch=${branch}`, dir], dir);
  runGit(['-C', dir, 'config', 'user.email', 'test@example.com'], dir);
  runGit(['-C', dir, 'config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  runGit(['-C', dir, 'add', 'file.txt'], dir);
  runGit(['-C', dir, 'commit', '-q', '-m', 'initial commit'], dir);
}

function makeIdentity(originPath: string) {
  return { provider: 'github' as const, host: 'local-test', owner: 'owner', repo: 'repo', httpsUrl: originPath };
}

describe('LocalRepoCloneService concurrency', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  it('serializes two concurrent clones into the SAME target directory — exactly one succeeds, the other sees a non-empty target instead of corrupting the checkout', async () => {
    const { LocalRepoCloneService, LocalCloneTargetNotEmptyError } = await import('./LocalRepoCloneService.js');
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetRoot = makeTmpDir('azito-clone-target-');
    // A path that does not exist yet — both callers race to be first to
    // create it, exactly the scenario the review flagged.
    const targetDir = path.join(targetRoot, 'shared-target');

    const service = new LocalRepoCloneService();
    const results = await Promise.allSettled([
      service.clone(makeIdentity(origin), null, 'main', targetDir),
      service.clone(makeIdentity(origin), null, 'main', targetDir),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Without serialization this is flaky (both could "succeed" against a
    // half-written checkout, or both could fail); with the target-path
    // mutex it is deterministic: whichever call actually wins the lock
    // first fully completes the clone before the second one's
    // assertTargetEmpty() ever runs, so the second always sees a populated
    // directory and rejects with the existing "not empty" error — never a
    // git-level race.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LocalCloneTargetNotEmptyError);

    // The one clone that did land must be a clean, complete checkout — not
    // a partially-overwritten mix of two concurrent `git clone` processes.
    expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'file.txt'))).toBe(true);
  });

  it('does not serialize clones into DIFFERENT target directories — they run concurrently', async () => {
    vi.resetModules();
    // Instead of inferring concurrency from elapsed wall-clock time (flaky
    // under load — see the real-time regression this test itself replaced),
    // directly observe overlap: track how many mocked `git clone` calls are
    // in flight at once. A truly concurrent run must, at some point, have
    // two in flight simultaneously; a serialized run never would.
    let inFlight = 0;
    let maxInFlight = 0;
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      return {
        ...actual,
        execFile: (...args: unknown[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') {
            const patchedArgs = args.slice(0, -1);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            patchedArgs.push((...cbArgs: unknown[]) => {
              setTimeout(() => {
                inFlight -= 1;
                (cb as (...a: unknown[]) => void)(...cbArgs);
              }, 50);
            });
            return (actual.execFile as (...a: unknown[]) => unknown)(...patchedArgs);
          }
          return (actual.execFile as (...a: unknown[]) => unknown)(...args);
        },
      };
    });

    const { LocalRepoCloneService } = await import('./LocalRepoCloneService.js');
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDirA = path.join(targetRoot, 'project-a');
    const targetDirB = path.join(targetRoot, 'project-b');

    const service = new LocalRepoCloneService();
    await Promise.all([
      service.clone(makeIdentity(origin), null, 'main', targetDirA),
      service.clone(makeIdentity(origin), null, 'main', targetDirB),
    ]);

    // Two different targets must have overlapped in flight — proof they ran
    // concurrently rather than being serialized by a shared lock.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(targetDirA, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(targetDirB, '.git'))).toBe(true);

    vi.doUnmock('child_process');
  });
});
