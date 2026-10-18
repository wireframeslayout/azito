import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { HubRepoCache } from './HubRepoCache';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';

// Issue #87 (hub 代行 git 配信) correctness bug: `fetchWithAskPass()` used to
// run a bare `git fetch origin <branch>`, which — under git's default fetch
// refspec — only ever populates `refs/remotes/origin/<branch>`. But
// `resolveRef()`/`createBundle()` both read `refs/heads/<branch>` directly,
// so the very first distribution always failed with "fatal: ambiguous
// argument". These tests build a real local bare repo (never a real GitHub/
// GitLab remote — see AGENTS.md-adjacent task constraints) and exercise the
// actual `git` binary end to end, to prove the fix (mirroring `refs/heads/*`
// into the cache's own `refs/heads/*` via `remote.origin.fetch`) works and
// that pre-existing caches (created before this fix, with the default
// refspec already configured) self-heal on next use.

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

function createOriginRepo(dir: string, branch: string): string {
  fs.mkdirSync(dir, { recursive: true });
  runGit(['init', '-q', `--initial-branch=${branch}`, dir], dir);
  runGit(['-C', dir, 'config', 'user.email', 'test@example.com'], dir);
  runGit(['-C', dir, 'config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  runGit(['-C', dir, 'add', 'file.txt'], dir);
  runGit(['-C', dir, 'commit', '-q', '-m', 'initial commit'], dir);
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  return sha;
}

function makeIdentity(originPath: string): CanonicalRepositoryIdentity {
  return {
    provider: 'github',
    host: 'local-test',
    owner: 'owner',
    repo: 'repo',
    // Deliberately a local filesystem path, never a real https:// remote —
    // `embedUsername()` falls back to returning it unchanged when `new
    // URL()` throws, and a local path works as a git fetch source exactly
    // like a real remote would, without ever touching the network.
    httpsUrl: originPath,
  };
}

describe('HubRepoCache', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  it('resolves refs/heads/<branch> after the first-ever fetch (first distribution no longer fails)', () => {
    const originDir = makeTmpDir('azito-hubrepocache-origin-');
    const branch = 'main';
    const originSha = createOriginRepo(originDir, branch);

    const dataDir = makeTmpDir('azito-hubrepocache-data-');
    const cache = new HubRepoCache(dataDir);
    const identity = makeIdentity(originDir);

    const sha = cache.ensureFetched(identity, 'unused-token', branch);

    expect(sha).toBe(originSha);

    // Independently confirm refs/heads/<branch> (not just refs/remotes/
    // origin/<branch>) is resolvable in the cache's bare repo — this is the
    // exact ref createBundle()/resolveRef() depend on.
    const repoCacheRoot = path.join(dataDir, 'repo-cache');
    const cacheDirName = fs.readdirSync(repoCacheRoot)[0];
    const repoDir = path.join(repoCacheRoot, cacheDirName);
    const resolved = execFileSync('git', ['-C', repoDir, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf-8',
    }).trim();
    expect(resolved).toBe(originSha);
  });

  it('createBundle succeeds against the branch after ensureFetched (no more "ambiguous argument")', () => {
    const originDir = makeTmpDir('azito-hubrepocache-origin-');
    const branch = 'main';
    const originSha = createOriginRepo(originDir, branch);

    const dataDir = makeTmpDir('azito-hubrepocache-data-');
    const cache = new HubRepoCache(dataDir);
    const identity = makeIdentity(originDir);

    cache.ensureFetched(identity, 'unused-token', branch);
    const { bundlePath, headSha } = cache.createBundle(identity, branch);
    tmpDirs.push(bundlePath); // cleaned up alongside the other tmp dirs (rmSync tolerates files)

    expect(headSha).toBe(originSha);
    expect(fs.existsSync(bundlePath)).toBe(true);
  });

  it('self-heals a pre-existing cache created under the old default fetch refspec', () => {
    const originDir = makeTmpDir('azito-hubrepocache-origin-');
    const branch = 'main';
    const originSha = createOriginRepo(originDir, branch);

    const dataDir = makeTmpDir('azito-hubrepocache-data-');
    const identity = makeIdentity(originDir);

    // Simulate a cache directory created by the pre-fix code: bare repo +
    // `origin` remote added via `git remote add`, left with git's default
    // fetch refspec (refs/heads/*:refs/remotes/origin/*) — never touching
    // remote.origin.fetch the way the fixed ensureBareRepo() now does.
    const repoCacheRoot = path.join(dataDir, 'repo-cache');
    fs.mkdirSync(repoCacheRoot, { recursive: true });
    const hash = require('crypto').createHash('sha256').update(identity.httpsUrl).digest('hex').slice(0, 16);
    const repoDir = path.join(repoCacheRoot, hash);
    fs.mkdirSync(repoDir, { recursive: true });
    runGit(['init', '-q', '--bare', repoDir], repoDir);
    runGit(['-C', repoDir, 'remote', 'add', 'origin', originDir], repoDir);
    // Reproduce the bug directly: fetch under the default refspec only.
    runGit(['-C', repoDir, 'fetch', 'origin', branch], repoDir);
    expect(() =>
      execFileSync('git', ['-C', repoDir, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf-8' }),
    ).toThrow();

    const cache = new HubRepoCache(dataDir);
    const sha = cache.ensureFetched(identity, 'unused-token', branch);

    expect(sha).toBe(originSha);
  });
});
