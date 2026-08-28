import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { RemoteBundleOps } from './RemoteBundleOps';
import type { IServerTransport } from '../../servers/transport/ServerTransport';

// Regression coverage for Issue #87 review finding 1 (Important, confirmed
// via real git): a second (and later) distribution to the same workingDir
// must actually update it — not silently leave it pinned to the commit it
// was first cloned at.
//
// Everything here runs against real local filesystem repos under `/tmp`
// (never a real remote): a bare repo standing in for the server-side
// mirror, and a plain repo standing in for the workingDir that
// `FetchDistributionService.ensureWorkingDir` creates/updates on the
// (simulated) remote server. `RemoteBundleOps` only ever builds shell
// command strings and hands them to a transport — this test's fake
// transport runs those strings locally via `bash -c`, so it exercises the
// exact command strings the real `AgentTransport`/`SshTransport` would run.

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

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

describe('RemoteBundleOps mirror -> workingDir sync (regression, real local git)', () => {
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

  it('a second distribution updates the workingDir local branch to the new SHA (not just refs/remotes/origin)', async () => {
    const ops = new RemoteBundleOps();
    const transport = localTransport();

    // 1. Server-side bare mirror (~/.azito/repos/<hash>.git stand-in).
    const mirrorDir = makeTmpDir('azito-mirror-sync-mirror-');
    runGit(['init', '-q', '--bare', '--initial-branch=main', mirrorDir], mirrorDir);

    // 2. A source checkout used only to push v1/v2 into the mirror
    //    (standing in for the hub pushing bundles across distributions).
    const srcDir = makeTmpDir('azito-mirror-sync-src-');
    runGit(['init', '-q', '--initial-branch=main', srcDir], srcDir);
    runGit(['config', 'user.email', 'test@example.com'], srcDir);
    runGit(['config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v1\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v1'], srcDir);
    const shaV1 = runGit(['rev-parse', 'HEAD'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);

    // 3. First distribution: workingDir does not exist yet -> clone.
    const workingDir = path.join(makeTmpDir('azito-mirror-sync-wd-parent-'), 'repo');
    await ops.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main');
    expect(runGit(['rev-parse', 'refs/heads/main'], workingDir)).toBe(shaV1);

    // 4. Second distribution's content lands in the mirror (e.g. after
    //    ordinary further commits on the source branch).
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v2\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v2'], srcDir);
    const shaV2 = runGit(['rev-parse', 'HEAD'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);
    expect(shaV2).not.toBe(shaV1);

    // 5. Second distribution's workingDir update path.
    await ops.fetchWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main');

    // The bug: the old implementation only updated refs/remotes/origin/main,
    // leaving refs/heads/main (what `git worktree add -b <t> <p> main`
    // actually resolves) pinned at v1.
    expect(runGit(['rev-parse', 'refs/heads/main'], workingDir)).toBe(shaV2);
    expect(runGit(['rev-parse', 'refs/remotes/origin/main'], workingDir)).toBe(shaV2);

    // 6. End-to-end: a worktree created off workingDir's `main` (exactly
    //    what `RemoteWorktreeService.create()` does for a task) must now
    //    get v2, not v1.
    const worktreePath = path.join(makeTmpDir('azito-mirror-sync-wt-parent-'), 'task-1');
    runGit(['worktree', 'add', '-b', 'task/1-regression', worktreePath, 'main'], workingDir);
    expect(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf-8')).toBe('v2\n');
  }, 30_000);

  it('workingDir HEAD is detached after clone, so a later fetch does not hit "checked out" refusal', async () => {
    const ops = new RemoteBundleOps();
    const transport = localTransport();

    const mirrorDir = makeTmpDir('azito-mirror-detach-mirror-');
    runGit(['init', '-q', '--bare', '--initial-branch=main', mirrorDir], mirrorDir);

    const srcDir = makeTmpDir('azito-mirror-detach-src-');
    runGit(['init', '-q', '--initial-branch=main', srcDir], srcDir);
    runGit(['config', 'user.email', 'test@example.com'], srcDir);
    runGit(['config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v1\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v1'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);

    const workingDir = path.join(makeTmpDir('azito-mirror-detach-wd-parent-'), 'repo');
    await ops.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main');

    // `git symbolic-ref HEAD` exits non-zero (and this helper throws) when
    // HEAD is detached, so a thrown error is exactly what a detached HEAD
    // looks like here.
    let detached = false;
    try {
      runGit(['symbolic-ref', '-q', 'HEAD'], workingDir);
    } catch {
      detached = true;
    }
    expect(detached).toBe(true);

    // The regression this guards against: a still-checked-out branch makes
    // the local-branch-updating refspec in `fetchWorkingDirFromMirror` fail
    // with "refusing to fetch into branch ... checked out". Confirm the
    // second-distribution fetch succeeds without throwing.
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v2\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v2'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);
    await expect(ops.fetchWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main')).resolves.not.toThrow();
  }, 30_000);
});
