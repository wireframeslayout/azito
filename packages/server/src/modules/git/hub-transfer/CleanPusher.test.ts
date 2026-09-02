import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CleanPusher } from './CleanPusher';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';

// `execFileSync` is re-exported through a spy wrapper (rather than
// `vi.spyOn(childProcess, 'execFileSync')`) because Vitest 4 runs
// `child_process` as a real ESM module whose namespace object is not
// configurable, so `spyOn` can't redefine the export directly.
const execFileSyncCalls: [string, string[]][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      const [cmd, cmdArgs] = args as [string, string[], unknown];
      execFileSyncCalls.push([cmd, cmdArgs]);
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// Issue #87 review finding: `push()` fetches an untrusted bundle (built from
// a server-side worktree the hub does not control) into its bare repo
// without `fetch.fsckObjects`/`transfer.fsckObjects`, which git defaults to
// false. These tests confirm (a) the fsck flags are actually passed on the
// fetch invocation that ingests the bundle, and (b) a legitimate push still
// works end to end against a real local bare repo (never a real GitHub/
// GitLab remote).

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

function makeIdentity(remotePath: string): CanonicalRepositoryIdentity {
  return {
    provider: 'github',
    host: 'local-test',
    owner: 'owner',
    repo: 'repo',
    // Local filesystem path standing in for the remote — never a real
    // https:// URL, so no real GitHub/GitLab push ever happens.
    httpsUrl: remotePath,
  };
}

describe('CleanPusher', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    execFileSyncCalls.length = 0;
    for (const dir of tmpDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function makeBundle(branch: string): { bundlePath: string; sha: string } {
    const srcDir = makeTmpDir('azito-cleanpusher-src-');
    runGit(['init', '-q', `--initial-branch=${branch}`, srcDir], srcDir);
    runGit(['-C', srcDir, 'config', 'user.email', 'test@example.com'], srcDir);
    runGit(['-C', srcDir, 'config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'hello\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'initial commit'], srcDir);
    const sha = execFileSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const bundlePath = path.join(makeTmpDir('azito-cleanpusher-bundle-'), 'test.bundle');
    runGit(['-C', srcDir, 'bundle', 'create', bundlePath, `refs/heads/${branch}`], srcDir);
    return { bundlePath, sha };
  }

  it('pushes a legitimate bundle to a local bare "remote" end to end', () => {
    const branch = 'main';
    const { bundlePath, sha } = makeBundle(branch);

    const remoteDir = makeTmpDir('azito-cleanpusher-remote-');
    runGit(['init', '-q', '--bare', remoteDir], remoteDir);

    const pusher = new CleanPusher();
    const identity = makeIdentity(remoteDir);
    const result = pusher.push(bundlePath, identity, 'unused-token', branch);

    expect(result.pushedSha).toBe(sha);

    const remoteSha = execFileSync('git', ['-C', remoteDir, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf-8',
    }).trim();
    expect(remoteSha).toBe(sha);
  });

  it('fetches the untrusted bundle with fetch.fsckObjects/transfer.fsckObjects enabled', () => {
    const branch = 'main';
    const { bundlePath } = makeBundle(branch);

    const remoteDir = makeTmpDir('azito-cleanpusher-remote-');
    runGit(['init', '-q', '--bare', remoteDir], remoteDir);

    const pusher = new CleanPusher();
    const identity = makeIdentity(remoteDir);
    pusher.push(bundlePath, identity, 'unused-token', branch);

    const fetchCall = execFileSyncCalls.find(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args.includes('fetch'),
    );
    expect(fetchCall).toBeDefined();
    const fetchArgs = fetchCall![1];
    expect(fetchArgs).toContain('fetch.fsckObjects=true');
    expect(fetchArgs).toContain('transfer.fsckObjects=true');

    const initCall = execFileSyncCalls.find(
      ([cmd, args]) => cmd === 'git' && Array.isArray(args) && args.includes('init') && args.includes('-c'),
    );
    expect(initCall).toBeDefined();
    expect(initCall![1]).toContain('core.hooksPath=/dev/null');
  });

  // #124 Bug 1: incremental bundle + empty bare repo
  it('fails on incremental bundle without seed (prerequisite missing)', () => {
    const branch = 'main';
    const srcDir = makeTmpDir('azito-cleanpusher-incr-src-');
    runGit(['init', '-q', `--initial-branch=${branch}`, srcDir], srcDir);
    runGit(['-C', srcDir, 'config', 'user.email', 'test@example.com'], srcDir);
    runGit(['-C', srcDir, 'config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'base\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'base commit'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'incremental\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'incremental commit'], srcDir);

    // Create incremental bundle: only the tip commit, with the base as prerequisite
    const baseSha = execFileSync('git', ['-C', srcDir, 'rev-parse', 'HEAD~1'], { encoding: 'utf-8' }).trim();
    const bundlePath = path.join(makeTmpDir('azito-cleanpusher-incr-bundle-'), 'incr.bundle');
    runGit(['-C', srcDir, 'bundle', 'create', bundlePath, `refs/heads/${branch}`, `--not`, baseSha], srcDir);

    const remoteDir = makeTmpDir('azito-cleanpusher-incr-remote-');
    runGit(['init', '-q', '--bare', remoteDir], remoteDir);

    const pusher = new CleanPusher();
    expect(() => pusher.push(bundlePath, makeIdentity(remoteDir), 'unused-token', branch)).toThrow();
  });

  it('succeeds on incremental bundle with seedDir providing prerequisites (#124 Bug 1)', () => {
    const branch = 'main';
    const srcDir = makeTmpDir('azito-cleanpusher-seed-src-');
    runGit(['init', '-q', `--initial-branch=${branch}`, srcDir], srcDir);
    runGit(['-C', srcDir, 'config', 'user.email', 'test@example.com'], srcDir);
    runGit(['-C', srcDir, 'config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'base\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'base commit'], srcDir);
    const baseSha = execFileSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'incremental\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'incremental commit'], srcDir);
    const tipSha = execFileSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    // Incremental bundle: tip only, base as prerequisite
    const bundlePath = path.join(makeTmpDir('azito-cleanpusher-seed-bundle-'), 'incr.bundle');
    runGit(['-C', srcDir, 'bundle', 'create', bundlePath, `${baseSha}..refs/heads/${branch}`], srcDir);

    // Seed repo has the base commit (simulating hub repo-cache)
    const seedDir = makeTmpDir('azito-cleanpusher-seed-cache-');
    runGit(['clone', '-q', '--bare', '--no-tags', srcDir, seedDir], seedDir);

    const remoteDir = makeTmpDir('azito-cleanpusher-seed-remote-');
    runGit(['init', '-q', '--bare', remoteDir], remoteDir);

    const pusher = new CleanPusher();
    const result = pusher.push(bundlePath, makeIdentity(remoteDir), 'unused-token', branch, seedDir);
    expect(result.pushedSha).toBe(tipSha);

    const remoteSha = execFileSync('git', ['-C', remoteDir, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf-8' }).trim();
    expect(remoteSha).toBe(tipSha);
  });
});
