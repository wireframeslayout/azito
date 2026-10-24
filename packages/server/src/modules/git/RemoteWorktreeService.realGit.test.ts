import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { LocalTransport } from '../servers/transport/LocalTransport';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { toHostProfile } from '../../shared/os/hostProfile';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import { WorktreeServiceFactory } from './WorktreeServiceFactory';
import { runGit } from './runGit';

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
    git(created.path, 'add', '.');
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
    const homeRepo = mkdtempSync(join(homedir(), 'azito-worktree-home-'));
    try {
      initRepo(homeRepo);
      const tilde = `~/${basename(homeRepo)}`;
      const created = await svc.create(tilde, 8, 'home', 'main');
      expect(realpathSync.native(created.path)).toBe(realpathSync.native(join(homeRepo, '.worktrees', 'task-8')));
      expect(await svc.getBranch(`${tilde}/.worktrees/task-8`)).toBe('task/8-home');
      expect((await runGit(transport, undefined, ['-C', tilde, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
      await svc.remove(tilde, `${tilde}/.worktrees/task-8`);
      expect(existsSync(join(homeRepo, '.worktrees', 'task-8'))).toBe(false);
    } finally {
      rmSync(homeRepo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('resolves a ~\\ working directory on Windows', async () => {
    const homeRepo = mkdtempSync(join(homedir(), 'azito-worktree-home-'));
    try {
      initRepo(homeRepo);
      const created = await svc.create(`~\\${basename(homeRepo)}`, 9, 'home', 'main');
      expect(existsSync(created.path)).toBe(true);
      await svc.remove(`~\\${basename(homeRepo)}`, created.path);
      expect(existsSync(created.path)).toBe(false);
    } finally {
      rmSync(homeRepo, { recursive: true, force: true });
    }
  });
});
