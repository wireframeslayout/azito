import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LocalRepoCloneService, LocalCloneTargetNotEmptyError } from './LocalRepoCloneService';
import type { CanonicalRepositoryIdentity } from './resolveCanonicalRepositoryIdentity';

// Never hits a real remote (github.com/gitlab.com etc.) — every fixture repo
// here is a throwaway local git repository under the OS tmp dir, matching
// HubRepoCache.test.ts's existing convention (see its own doc comment).

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

function makeIdentity(originPath: string): CanonicalRepositoryIdentity {
  return { provider: 'github', host: 'local-test', owner: 'owner', repo: 'repo', httpsUrl: originPath };
}

describe('LocalRepoCloneService', () => {
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

  it('clones the branch into the target directory', async () => {
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'nested', 'project');

    const service = new LocalRepoCloneService();
    await service.clone(makeIdentity(origin), null, 'main', targetDir);

    expect(fs.existsSync(path.join(targetDir, 'file.txt'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(true);
  });

  it('creates missing parent directories for the target', async () => {
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'a', 'b', 'c');

    const service = new LocalRepoCloneService();
    await expect(service.clone(makeIdentity(origin), null, 'main', targetDir)).resolves.not.toThrow();
    expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(true);
  });

  it('fails when the target directory already exists and is not empty, without touching it', async () => {
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetDir = makeTmpDir('azito-clone-target-');
    fs.writeFileSync(path.join(targetDir, 'preexisting.txt'), 'do not touch\n');

    const service = new LocalRepoCloneService();
    await expect(service.clone(makeIdentity(origin), null, 'main', targetDir)).rejects.toThrow(LocalCloneTargetNotEmptyError);

    // The pre-existing content must survive untouched.
    expect(fs.readFileSync(path.join(targetDir, 'preexisting.txt'), 'utf-8')).toBe('do not touch\n');
    expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(false);
  });

  it('succeeds when the target directory already exists but is empty', async () => {
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetDir = makeTmpDir('azito-clone-target-');

    const service = new LocalRepoCloneService();
    await expect(service.clone(makeIdentity(origin), null, 'main', targetDir)).resolves.not.toThrow();
    expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(true);
  });

  it('never leaves the askpass script (which holds the token) behind after a successful clone', async () => {
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'project');
    const token = 'super-secret-token-value';

    const service = new LocalRepoCloneService();
    await service.clone(makeIdentity(origin), token, 'main', targetDir);

    // The askpass script (mode 0700, holds the token) must be cleaned up —
    // it is the only place the token is ever written to disk.
    const leftover = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('azito-clone-askpass-'));
    expect(leftover).toEqual([]);
    expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(true);
  });

  it('never leaks the token into a thrown error, and cleans up the askpass script on failure too (no real remote touched)', async () => {
    const service = new LocalRepoCloneService();
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'project');
    const token = 'super-secret-token-value';
    // A local path that does not exist — git fails fast with no network
    // access at all (same "never touch a real remote" constraint as
    // HubRepoCache.test.ts).
    const badIdentity = makeIdentity(path.join(targetRoot, 'no-such-origin-repo'));

    let thrown: Error | null = null;
    try {
      await service.clone(badIdentity, token, 'main', targetDir);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).not.toContain(token);

    const leftover = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('azito-clone-askpass-'));
    expect(leftover).toEqual([]);
  });

  it('returns a Promise rather than blocking synchronously (review finding: sync clone froze the whole hub for up to 300s)', () => {
    const origin = makeTmpDir('azito-clone-origin-');
    createOriginRepo(origin, 'main');
    const targetRoot = makeTmpDir('azito-clone-target-');
    const targetDir = path.join(targetRoot, 'project');

    const service = new LocalRepoCloneService();
    const result = service.clone(makeIdentity(origin), null, 'main', targetDir);

    // A synchronous (execFileSync-based) implementation would have already
    // completed the clone by the time `clone()` returns, and would return
    // `undefined`, not a thenable. Returning a Promise is the observable
    // signal that the git subprocess is driven asynchronously (via
    // `execFile`/callback, not `execFileSync`), so the caller — and the
    // Fastify event loop — is never blocked waiting for it inline.
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('does not import or call execFileSync anywhere in the source (must stay fully async — no event-loop-blocking clone)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'LocalRepoCloneService.ts'), 'utf-8');
    expect(source).not.toMatch(/execFileSync\(/);
    expect(source).not.toMatch(/[^.\w]execSync\(/);
  });
});
