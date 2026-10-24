import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { LocalTransport } from '../servers/transport/LocalTransport';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { toHostProfile } from '../../shared/os/hostProfile';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import { WorktreeServiceFactory } from './WorktreeServiceFactory';
import { runGit } from './runGit';
import { TaskCleanupService, type TaskCleanupDeps } from '../tasks/TaskCleanupService';
import type { Task } from '../tasks/Task';

/**
 * Worktree create / remove against the real git of the machine the test runs on (Git for Windows on the Windows CI runner),
 * through LocalTransport: the path every `local` server takes. The repository sits in a directory with a space and Japanese
 * characters, which the old shell-safe pattern refused.
 */
const hostEnv = resolveCurrentHostEnv();
const profile = toHostProfile(hostEnv.platform, hostEnv.arch);
const transport = new LocalTransport({ bin: 'tmux', baseArgs: [] } as never, 'http://hub', hostEnv, TaskTempFiles.fromHostEnv(hostEnv), profile);
const svc = new WorktreeServiceFactory().create(transport);

let root: string;
let repo: string;
/** The home `~` means in the `~` tests: a folder of the test, so the real home is never touched. */
let fakeHome: string;
let homeTransport: LocalTransport;
let homeSvc: ReturnType<WorktreeServiceFactory['create']>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
}

beforeAll(() => {
  // realpath: a macOS temp folder / a Windows short (8.3) name would otherwise differ from what git prints.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-worktree-')));
  repo = join(root, 'my repo 日本語');
  initRepo(repo);
  fakeHome = join(root, 'home');
  mkdirSync(fakeHome);
  homeTransport = new LocalTransport({ bin: 'tmux', baseArgs: [] } as never, 'http://hub', { ...hostEnv, homeDir: fakeHome }, TaskTempFiles.fromHostEnv(hostEnv), profile);
  homeSvc = new WorktreeServiceFactory().create(homeTransport);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RemoteWorktreeService over LocalTransport with a real git', () => {
  it('is the same service for a local server as for a remote one', () => {
    expect(svc).toBeInstanceOf(RemoteWorktreeService);
  });

  it('creates and removes a worktree in a directory with a space and Japanese characters', async () => {
    const created = await svc.create(repo, 1, 'slug', 'main');
    expect(created).toEqual({ path: join(repo, '.worktrees', 'task-1'), branch: 'task/1-slug' });
    expect(existsSync(join(created.path, 'a.txt'))).toBe(true);
    expect(await svc.exists(created.path)).toBe(true);
    expect(await svc.getBranch(created.path)).toBe('task/1-slug');
    expect((await svc.list(repo)).map((e) => e.path)).toContain(created.path);

    await svc.remove(repo, created.path);
    expect(existsSync(created.path)).toBe(false);
    expect(await svc.exists(created.path)).toBe(false);
    expect((await svc.list(repo)).map((e) => e.path)).not.toContain(created.path);
  });

  it('recreates a worktree whose directory is left over from an earlier run (stale)', async () => {
    const first = await svc.create(repo, 2, 'again', 'main');
    writeFileSync(join(first.path, 'dirty.txt'), 'left over\n');
    const second = await svc.create(repo, 2, 'again', 'main');
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'dirty.txt'))).toBe(false);
    await svc.remove(repo, second.path);
  });

  it('uses an existing branch when a branch name is given, and recovers when it is registered in a stale worktree', async () => {
    git(repo, 'branch', 'feature/existing');
    const first = await svc.create(repo, 3, 'x', 'main', 'feature/existing');
    expect(first.branch).toBe('feature/existing');
    // the directory is deleted behind git's back: the branch is still "used by" the vanished worktree
    rmSync(first.path, { recursive: true, force: true });
    const second = await svc.create(repo, 4, 'x', 'main', 'feature/existing');
    expect(second.branch).toBe('feature/existing');
    expect(await svc.getBranch(second.path)).toBe('feature/existing');
    await svc.remove(repo, second.path);
  });

  it('reports a name-status diff of a worktree against its base', async () => {
    const created = await svc.create(repo, 5, 'diff', 'main');
    writeFileSync(join(created.path, 'b.txt'), 'two\n');
    // only the new file: the checkout of a.txt may differ in line endings on Windows (core.autocrlf)
    git(created.path, 'add', 'b.txt');
    git(created.path, 'commit', '-q', '-m', 'second');
    expect(JSON.parse((await svc.getDiff(created.path, 'main')) ?? 'null')).toEqual([{ status: 'A', file: 'b.txt' }]);
    await svc.remove(repo, created.path);
  });

  it('fails when the working directory is not a repository, instead of reporting success', async () => {
    const notRepo = join(root, 'not a repo');
    mkdirSync(notRepo);
    await expect(svc.create(notRepo, 6, 'x', 'main')).rejects.toThrow(/git worktree add failed/);
  });

  it('resolves a ~ working directory against the host home (cwd and -C), for create and remove', async () => {
    const homeRepo = mkdtempSync(join(fakeHome, 'repo-'));
    initRepo(homeRepo);
    const tilde = `~/${basename(homeRepo)}`;
    const created = await homeSvc.create(tilde, 8, 'home', 'main');
    expect(realpathSync.native(created.path)).toBe(realpathSync.native(join(homeRepo, '.worktrees', 'task-8')));
    expect(await homeSvc.getBranch(`${tilde}/.worktrees/task-8`)).toBe('task/8-home');
    expect((await runGit(homeTransport, undefined, ['-C', tilde, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
    await homeSvc.remove(tilde, `${tilde}/.worktrees/task-8`);
    expect(existsSync(join(homeRepo, '.worktrees', 'task-8'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('resolves a ~\\ working directory on Windows', async () => {
    const homeRepo = mkdtempSync(join(fakeHome, 'repo-'));
    initRepo(homeRepo);
    const created = await homeSvc.create(`~\\${basename(homeRepo)}`, 9, 'home', 'main');
    expect(existsSync(created.path)).toBe(true);
    await homeSvc.remove(`~\\${basename(homeRepo)}`, created.path);
    expect(existsSync(created.path)).toBe(false);
  });

  // Windows normalises `..` before the file system sees it, so a junction followed by `..` is lexical there.
  it.skipIf(process.platform === 'win32')('follows a symbolic link before `..`: the worktree is made beside the real directory, not beside the link', async () => {
    const base = join(root, 'symlink-case');
    const real = join(base, 'b', 'repo');
    initRepo(real);
    mkdirSync(join(base, 'b', 'sub'), { recursive: true });
    mkdirSync(join(base, 'a', 'repo', '.worktrees', 'task-1'), { recursive: true });
    writeFileSync(join(base, 'a', 'repo', '.worktrees', 'task-1', 'keep.txt'), 'must survive');
    symlinkSync(join(base, 'b', 'sub'), join(base, 'a', 'link'));
    // built by concatenation: path.join would remove the `..` lexically, which is the very thing under test
    const viaLink = `${join(base, 'a', 'link')}/../repo`;

    const created = await svc.create(viaLink, 1, 'sym', 'main');
    expect(created.path).toBe(join(real, '.worktrees', 'task-1'));
    expect(existsSync(join(created.path, 'a.txt'))).toBe(true);
    // the directory at the lexical location was not touched by the stale-worktree recovery
    expect(existsSync(join(base, 'a', 'repo', '.worktrees', 'task-1', 'keep.txt'))).toBe(true);

    await svc.remove(viaLink, `${viaLink}/.worktrees/task-1`);
    expect(existsSync(created.path)).toBe(false);
    expect(existsSync(join(base, 'a', 'repo', '.worktrees', 'task-1', 'keep.txt'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('removes with the value create() returned, in a structure with a symbolic link before `..`', async () => {
    const base = join(root, 'symlink-remove');
    const real = join(base, 'b', 'repo');
    initRepo(real);
    mkdirSync(join(base, 'b', 'sub'), { recursive: true });
    mkdirSync(join(base, 'a'), { recursive: true });
    symlinkSync(join(base, 'b', 'sub'), join(base, 'a', 'link'));
    const viaLink = `${join(base, 'a', 'link')}/../repo`;

    const created = await svc.create(viaLink, 2, 'rm', 'main');
    expect(existsSync(created.path)).toBe(true);
    await svc.remove(viaLink, created.path);
    expect(existsSync(created.path)).toBe(false);
    expect((await svc.list(real)).map((e) => e.path)).not.toContain(created.path);

    // the stored path in the other spelling (through the link) is the same directory and is removed too
    const again = await svc.create(viaLink, 3, 'rm', 'main');
    await svc.remove(viaLink, `${viaLink}/.worktrees/task-3`);
    expect(existsSync(again.path)).toBe(false);
  });

  it('leaves an unrelated directory alone when the worktree path no longer exists (prune only)', async () => {
    const created = await svc.create(repo, 20, 'gone', 'main');
    rmSync(created.path, { recursive: true, force: true });
    await svc.remove(repo, created.path);
    expect((await svc.list(repo)).map((e) => e.path)).not.toContain(created.path);
    expect(existsSync(repo)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('cleanup of a task removes the worktree create() returned, with a symbolic link before `..`', async () => {
    const base = join(root, 'symlink-cleanup');
    const real = join(base, 'b', 'repo');
    initRepo(real);
    mkdirSync(join(base, 'b', 'sub'), { recursive: true });
    mkdirSync(join(base, 'a'), { recursive: true });
    symlinkSync(join(base, 'b', 'sub'), join(base, 'a', 'link'));
    const viaLink = `${join(base, 'a', 'link')}/../repo`;
    const created = await svc.create(viaLink, 4, 'cl', 'main');

    const warn = vi.fn();
    const cleanup = new TaskCleanupService({
      serverRepo: { findByName: () => ({ name: 's', type: 'agent', hostProfile: profile }) },
      worktreeServiceFactory: new WorktreeServiceFactory(),
      transportFactory: { getTransport: () => transport, hostProfileFor: () => profile },
      projectServerRepo: { find: () => ({ workingDirectory: viaLink }), findByProject: () => [] },
      projectRepo: { findById: () => ({ id: 1 }) },
    } as unknown as TaskCleanupDeps);
    await cleanup.cleanup({ id: 4, projectId: 1, serverName: 's', worktreePath: created.path, workingDirectory: viaLink } as unknown as Task, { warn });
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(created.path)).toBe(false);
  });
});
