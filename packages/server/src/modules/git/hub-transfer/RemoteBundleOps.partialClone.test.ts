import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { RemoteBundleOps } from './RemoteBundleOps';
import { DUMMY_ORIGIN_URL } from './types';
import type { IServerTransport } from '../../servers/transport/ServerTransport';

function localTransport(): IServerTransport {
  return {
    exec: async (command: string) => {
      try {
        const stdout = execFileSync('bash', ['-c', command], { encoding: 'utf-8' });
        return { code: 0, stdout, stderr: '' };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
      }
    },
  } as unknown as IServerTransport;
}

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

describe('RemoteBundleOps partial clone detection and resolution (#124 Bug 2)', () => {
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

  function makeRepoWithPartialCloneConfig(config: 'promisor' | 'partialclonefilter' | 'extensions' | 'all'): { workingDir: string; mirrorDir: string } {
    const srcDir = makeTmpDir('azito-pc-src-');
    runGit(['init', '-q', '--initial-branch=main', srcDir], srcDir);
    runGit(['-C', srcDir, 'config', 'user.email', 'test@example.com'], srcDir);
    runGit(['-C', srcDir, 'config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'content\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'initial'], srcDir);

    const mirrorDir = makeTmpDir('azito-pc-mirror-');
    runGit(['clone', '-q', '--bare', srcDir, mirrorDir], mirrorDir);

    const workingDir = makeTmpDir('azito-pc-wd-');
    runGit(['clone', '-q', srcDir, workingDir], workingDir);

    // Simulate partial clone configuration
    if (config === 'promisor' || config === 'all') {
      runGit(['-C', workingDir, 'config', 'remote.origin.promisor', 'true'], workingDir);
    }
    if (config === 'partialclonefilter' || config === 'all') {
      runGit(['-C', workingDir, 'config', 'remote.origin.partialclonefilter', 'blob:none'], workingDir);
    }
    if (config === 'extensions' || config === 'all') {
      runGit(['-C', workingDir, 'config', 'extensions.partialclone', 'origin'], workingDir);
    }

    return { workingDir, mirrorDir };
  }

  it('detects promisor-only partial clone', async () => {
    const { workingDir } = makeRepoWithPartialCloneConfig('promisor');
    const ops = new RemoteBundleOps();
    expect(await ops.detectPartialClone(localTransport(), workingDir)).toBe(true);
  });

  it('detects partialclonefilter-only partial clone', async () => {
    const { workingDir } = makeRepoWithPartialCloneConfig('partialclonefilter');
    const ops = new RemoteBundleOps();
    expect(await ops.detectPartialClone(localTransport(), workingDir)).toBe(true);
  });

  it('detects extensions.partialclone-only partial clone', async () => {
    const { workingDir } = makeRepoWithPartialCloneConfig('extensions');
    const ops = new RemoteBundleOps();
    expect(await ops.detectPartialClone(localTransport(), workingDir)).toBe(true);
  });

  it('returns false for a normal clone', async () => {
    const srcDir = makeTmpDir('azito-pc-normal-src-');
    runGit(['init', '-q', '--initial-branch=main', srcDir], srcDir);
    runGit(['-C', srcDir, 'config', 'user.email', 'test@example.com'], srcDir);
    runGit(['-C', srcDir, 'config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'content\n');
    runGit(['-C', srcDir, 'add', 'file.txt'], srcDir);
    runGit(['-C', srcDir, 'commit', '-q', '-m', 'initial'], srcDir);

    const workingDir = makeTmpDir('azito-pc-normal-wd-');
    runGit(['clone', '-q', srcDir, workingDir], workingDir);

    const ops = new RemoteBundleOps();
    expect(await ops.detectPartialClone(localTransport(), workingDir)).toBe(false);
  });

  it('resolvePartialClone removes all partial clone settings and backfills from mirror', async () => {
    const { workingDir, mirrorDir } = makeRepoWithPartialCloneConfig('all');
    const ops = new RemoteBundleOps();

    await ops.resolvePartialClone(localTransport(), workingDir, mirrorDir);

    expect(await ops.detectPartialClone(localTransport(), workingDir)).toBe(false);
    // bundle create should work after resolution
    const bundlePath = path.join(makeTmpDir('azito-pc-bundle-'), 'test.bundle');
    execFileSync('git', ['-C', workingDir, 'bundle', 'create', bundlePath, 'refs/heads/main'], { encoding: 'utf-8' });
    expect(fs.existsSync(bundlePath)).toBe(true);
  });

  // #124: resolvePartialClone sets origin to mirrorDir temporarily;
  // ensureWorkingDir's setDummyOrigin must follow to restore the dummy.
  // This test verifies the ordering dependency explicitly.
  it('origin is mirror path after resolvePartialClone, restored to dummy by setDummyOrigin', async () => {
    const { workingDir, mirrorDir } = makeRepoWithPartialCloneConfig('all');
    const ops = new RemoteBundleOps();
    const transport = localTransport();

    await ops.resolvePartialClone(transport, workingDir, mirrorDir);

    // After resolvePartialClone, origin points at the mirror (not dummy)
    const originAfterResolve = execFileSync('git', ['-C', workingDir, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
    expect(originAfterResolve).toBe(mirrorDir);

    // setDummyOrigin restores the dummy
    await ops.setDummyOrigin(transport, workingDir);
    const originAfterDummy = execFileSync('git', ['-C', workingDir, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
    expect(originAfterDummy).toBe(DUMMY_ORIGIN_URL);
  });
});

describe('RemoteBundleOps.setGitIdentity (#124 Bug 5)', () => {
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

  it('sets user.name and user.email on the working directory', async () => {
    const workingDir = makeTmpDir('azito-identity-wd-');
    runGit(['init', '-q', '--initial-branch=main', workingDir], workingDir);

    const ops = new RemoteBundleOps();
    await ops.setGitIdentity(localTransport(), workingDir, { name: 'Hub Operator', email: 'operator@example.com' });

    const name = execFileSync('git', ['-C', workingDir, 'config', 'user.name'], { encoding: 'utf-8' }).trim();
    const email = execFileSync('git', ['-C', workingDir, 'config', 'user.email'], { encoding: 'utf-8' }).trim();
    expect(name).toBe('Hub Operator');
    expect(email).toBe('operator@example.com');
  });

  // #124 Bug 5 requirement: internal hostnames must not appear in commit history
  it('commit after setGitIdentity does not contain server hostname', async () => {
    const workingDir = makeTmpDir('azito-identity-commit-');
    runGit(['init', '-q', '--initial-branch=main', workingDir], workingDir);
    // Simulate a server's local default identity
    runGit(['-C', workingDir, 'config', 'user.name', 'serveruser'], workingDir);
    runGit(['-C', workingDir, 'config', 'user.email', 'serveruser@server006.tail8bef04.ts.net'], workingDir);

    const ops = new RemoteBundleOps();
    await ops.setGitIdentity(localTransport(), workingDir, { name: 'Hub Operator', email: 'operator@example.com' });

    fs.writeFileSync(path.join(workingDir, 'test.txt'), 'test\n');
    runGit(['-C', workingDir, 'add', 'test.txt'], workingDir);
    runGit(['-C', workingDir, 'commit', '-q', '-m', 'test commit'], workingDir);

    const author = execFileSync('git', ['-C', workingDir, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf-8' }).trim();
    expect(author).toBe('Hub Operator <operator@example.com>');
    expect(author).not.toContain('serveruser');
    expect(author).not.toContain('server006');
    expect(author).not.toContain('.ts.net');
  });
});
