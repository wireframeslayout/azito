import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { RemoteBundleOps } from './RemoteBundleOps';
import type { IServerTransport } from '../../servers/transport/ServerTransport';

// Regression coverage for Issue #87 review findings (confirmed via real
// git):
//
// - Finding 1 (original, 3cdfaf1a): a second (and later) distribution to
//   the same workingDir must actually update it, not silently leave it
//   pinned to the commit it was first cloned at.
// - Finding 2 (this task): 3cdfaf1a fixed finding 1 by force-updating the
//   workingDir's LOCAL branch ref via a forced refspec, which breaks the
//   moment that branch is checked out in a linked worktree (e.g.
//   `git worktree add <path> main`, which is exactly what happens when a
//   task's user-specified branch input names the base branch itself) — git
//   refuses the fetch with "refusing to fetch into branch ... checked out",
//   and every later distribution to that server x repo then fails forever.
//   The fix reverts to updating ONLY the tracking ref
//   (`refs/remotes/origin/<branch>`); callers that need the freshly
//   distributed content must resolve `origin/<branch>` themselves.
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

  it('a second distribution updates refs/remotes/origin/<branch> to the new SHA, and a worktree created from it gets the new content', async () => {
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
    expect(runGit(['rev-parse', 'refs/remotes/origin/main'], workingDir)).toBe(shaV1);

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

    // The current design: only the tracking ref is updated. The local
    // branch is intentionally left untouched (still v1) — callers that need
    // the newly distributed content must resolve `origin/<branch>`.
    expect(runGit(['rev-parse', 'refs/heads/main'], workingDir)).toBe(shaV1);
    expect(runGit(['rev-parse', 'refs/remotes/origin/main'], workingDir)).toBe(shaV2);

    // 6. End-to-end: a worktree created off workingDir's `origin/main`
    //    (exactly what ExecuteTaskUseCase now passes as the worktree
    //    creation base branch whenever distribution ran) must get v2.
    const worktreePath = path.join(makeTmpDir('azito-mirror-sync-wt-parent-'), 'task-1');
    runGit(['worktree', 'add', '-b', 'task/1-regression', worktreePath, 'origin/main'], workingDir);
    expect(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf-8')).toBe('v2\n');
  }, 30_000);

  it('a second distribution succeeds even when the distributed branch is checked out in a linked worktree (Issue #87 review finding)', async () => {
    const ops = new RemoteBundleOps();
    const transport = localTransport();

    // 1. Server-side bare mirror with two branches: `trunk` (workingDir's
    //    own primary checkout below) and `main` (the branch this test
    //    distributes and checks out in a LINKED worktree, reproducing a
    //    task whose branch input names the base branch itself).
    const mirrorDir = makeTmpDir('azito-mirror-linked-mirror-');
    runGit(['init', '-q', '--bare', '--initial-branch=trunk', mirrorDir], mirrorDir);

    const srcDir = makeTmpDir('azito-mirror-linked-src-');
    runGit(['init', '-q', '--initial-branch=trunk', srcDir], srcDir);
    runGit(['config', 'user.email', 'test@example.com'], srcDir);
    runGit(['config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'trunk.txt'), 'trunk\n');
    runGit(['add', 'trunk.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'trunk'], srcDir);
    runGit(['push', mirrorDir, 'trunk'], srcDir);

    runGit(['checkout', '-q', '-b', 'main'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v1\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v1'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);

    // 2. workingDir's own primary checkout is `trunk`, not `main` —
    //    matching how a real workingDir is cloned once per repo and reused
    //    across tasks whose branches vary.
    const workingDir = path.join(makeTmpDir('azito-mirror-linked-wd-parent-'), 'repo');
    await ops.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, 'trunk');

    // 3. Reproduce the review-report scenario: a task specifies the base
    //    branch name itself as its branch input, so
    //    `RemoteWorktreeService.create()` calls
    //    `git worktree add <path> <branch>` and `main` ends up checked out
    //    in a LINKED worktree.
    const linkedWorktreePath = path.join(makeTmpDir('azito-mirror-linked-wt-parent-'), 'task-main');
    runGit(['worktree', 'add', linkedWorktreePath, 'main'], workingDir);

    // 4. Second distribution's content for `main` lands in the mirror.
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v2\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v2'], srcDir);
    const shaV2 = runGit(['rev-parse', 'HEAD'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);

    // 5. The regression this guards against: with `main` checked out in a
    //    linked worktree, a refspec that force-updates `refs/heads/main`
    //    fails with "refusing to fetch into branch ... checked out". The
    //    fixed implementation never touches refs/heads/main, so this must
    //    succeed.
    await expect(ops.fetchWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main')).resolves.not.toThrow();
    expect(runGit(['rev-parse', 'refs/remotes/origin/main'], workingDir)).toBe(shaV2);
  }, 30_000);

  it('a first-time task on a freshly cloned workingDir can worktree-add the same branch name (Issue #87 review re-finding)', async () => {
    const ops = new RemoteBundleOps();
    const transport = localTransport();

    // 1. Server-side bare mirror with a single branch `main`.
    const mirrorDir = makeTmpDir('azito-mirror-clone-detach-mirror-');
    runGit(['init', '-q', '--bare', '--initial-branch=main', mirrorDir], mirrorDir);

    const srcDir = makeTmpDir('azito-mirror-clone-detach-src-');
    runGit(['init', '-q', '--initial-branch=main', srcDir], srcDir);
    runGit(['config', 'user.email', 'test@example.com'], srcDir);
    runGit(['config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v1\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v1'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);

    // 2. First-ever distribution for this server x repo -> clone
    //    `--branch main`. `git clone --branch` leaves `main` checked out
    //    in the PRIMARY checkout (workingDir) unless `ensureDetachedHead`
    //    is applied afterwards (as `FetchDistributionService.ensureWorkingDir`
    //    now always does, on both the clone and fetch path).
    const workingDir = path.join(makeTmpDir('azito-mirror-clone-detach-wd-parent-'), 'repo');
    await ops.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main');
    await ops.ensureDetachedHead(transport, workingDir);

    // 3. Without the detach, this reproduces:
    //    "fatal: 'main' is already used by worktree at '<workingDir>'"
    //    — a task whose branch input names the base branch itself, on its
    //    very first execution against this workingDir.
    const worktreePath = path.join(makeTmpDir('azito-mirror-clone-detach-wt-parent-'), 'task-1');
    expect(() => runGit(['worktree', 'add', worktreePath, 'main'], workingDir)).not.toThrow();
    expect(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf-8')).toBe('v1\n');
  }, 30_000);

  it('a workingDir that was left with HEAD attached (e.g. detach failed on a previous distribution) recovers on the next distribution via ensureDetachedHead', async () => {
    const ops = new RemoteBundleOps();
    const transport = localTransport();

    // 1. Server-side bare mirror with a single branch `main`.
    const mirrorDir = makeTmpDir('azito-mirror-recover-mirror-');
    runGit(['init', '-q', '--bare', '--initial-branch=main', mirrorDir], mirrorDir);

    const srcDir = makeTmpDir('azito-mirror-recover-src-');
    runGit(['init', '-q', '--initial-branch=main', srcDir], srcDir);
    runGit(['config', 'user.email', 'test@example.com'], srcDir);
    runGit(['config', 'user.name', 'Test'], srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v1\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v1'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);

    // 2. Simulate a workingDir that a PAST clone left with `main` still
    //    attached (i.e. `ensureDetachedHead` was never applied, or failed) —
    //    the exact state the review finding warns is otherwise unrecoverable.
    const workingDir = path.join(makeTmpDir('azito-mirror-recover-wd-parent-'), 'repo');
    await ops.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main');
    expect(runGit(['symbolic-ref', '-q', 'HEAD'], workingDir)).toBe('refs/heads/main');

    // 3. A LATER distribution to this same workingDir takes the "existing
    //    workingDir" path in `FetchDistributionService.ensureWorkingDir`:
    //    fetch (not clone), then `ensureDetachedHead` unconditionally.
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'v2\n');
    runGit(['add', 'file.txt'], srcDir);
    runGit(['commit', '-q', '-m', 'v2'], srcDir);
    runGit(['push', mirrorDir, 'main'], srcDir);
    await ops.fetchWorkingDirFromMirror(transport, mirrorDir, workingDir, 'main');
    await ops.ensureDetachedHead(transport, workingDir);

    // 4. HEAD is now detached, so a worktree can be added for `main`
    //    without hitting "already used by worktree".
    const worktreePath = path.join(makeTmpDir('azito-mirror-recover-wt-parent-'), 'task-1');
    expect(() => runGit(['worktree', 'add', worktreePath, 'main'], workingDir)).not.toThrow();

    // 5. Re-applying ensureDetachedHead is idempotent (already detached).
    await expect(ops.ensureDetachedHead(transport, workingDir)).resolves.not.toThrow();
  }, 30_000);
});
