import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { LocalTransport } from '../servers/transport/LocalTransport';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { toHostProfile } from '../../shared/os/hostProfile';
import { buildCommandSpec } from '../../shared/exec/commandSpec';
import { GitDiffService } from './GitDiffService';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import { RepoDiscoveryService } from './RepoDiscoveryService';
import { runGit } from './runGit';
import { taskIdOfWorktreePath } from './gitPath';

/**
 * The git read paths against a real git on the machine the test runs on (Git for Windows on the Windows CI runner), through
 * LocalTransport: a repository in a directory with a space and Japanese characters, reached by the host's own spelling.
 * These are service-level tests: the route guard that keeps a Windows host closed (`assertGitSupported`) is not involved.
 */
const hostEnv = resolveCurrentHostEnv();
const profile = toHostProfile(hostEnv.platform, hostEnv.arch);
const transport = new LocalTransport({ bin: 'tmux', baseArgs: [] } as never, 'http://hub', hostEnv, TaskTempFiles.fromHostEnv(hostEnv), profile);
const factory = { getTransport: () => transport } as unknown as TransportFactory;
const server = { name: 'local', type: 'local' } as unknown as ServerConfig;

let root: string;
let repo: string;
let initialCommit: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  // realpath: a temp folder on macOS / a Windows short (8.3) name (RUNNER~1) would otherwise differ from what git prints.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-gitread-')));
  repo = join(root, 'my repo 日本語');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  initialCommit = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feature/x');
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'second 日本語');
  // uncommitted: a tracked change, a staged file and an untracked file with a space in its name
  writeFileSync(join(repo, 'a.txt'), 'one\nchanged\n');
  writeFileSync(join(repo, 'staged.txt'), 'staged\n');
  git(repo, 'add', 'staged.txt');
  writeFileSync(join(repo, 'new file.txt'), 'untracked\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('git read paths with a real git', () => {
  const diffService = new GitDiffService(factory);

  it('lists commits', async () => {
    const commits = await diffService.getCommits(server, repo, 'main');
    expect(commits.map((c) => c.subject)).toEqual(['second 日本語']);
  });

  it('diffs uncommitted changes: tracked, staged and untracked (a name with a space)', async () => {
    const diff = await diffService.getDiff(server, repo, 'main', undefined, { scope: 'uncommitted' });
    const byFile = new Map(diff.files.map((f) => [f.file, f.group]));
    expect(byFile.get('a.txt')).toBe('unstaged');
    expect(byFile.get('staged.txt')).toBe('staged');
    expect(byFile.get('new file.txt')).toBe('untracked');
    expect(diff.headBranch).toBe('feature/x');
  });

  it('diffs against the base branch', async () => {
    const diff = await diffService.getDiff(server, repo, 'main', undefined, { scope: 'base', includeUncommitted: false });
    expect(diff.files.map((f) => f.file)).toEqual(['b.txt']);
  });

  it('diffs one commit', async () => {
    const hash = git(repo, 'rev-parse', 'HEAD');
    const diff = await diffService.getDiff(server, repo, 'main', hash, { scope: 'commit' });
    expect(diff.files.map((f) => f.file)).toEqual(['b.txt']);
    expect(initialCommit).not.toBe(hash);
  });

  it('lists branches with the command the branches route runs, in a working directory with a space and Japanese', async () => {
    const result = await transport.run(buildCommandSpec('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: repo }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual(['feature/x', 'main']);
  });

  it('lists worktrees in the host spelling', async () => {
    const worktree = join(repo, '.worktrees', 'task-7');
    git(repo, 'worktree', 'add', '-q', '-b', 'task/7-x', worktree);
    const viaTransport = await new RemoteWorktreeService(transport).list(repo);
    expect(viaTransport.map((e) => e.path)).toEqual([repo, worktree]);
    expect(viaTransport[0].isMain).toBe(true);
    expect(taskIdOfWorktreePath(profile.platform, viaTransport[1].path)).toBe(7);
    const status = await runGit(transport, undefined, ['-C', viaTransport[1].path, 'status', '--porcelain']);
    expect(status.exitCode).toBe(0);
  });

  it('prints the real path of a worktree even when the working directory is reached through a link', async () => {
    const link = join(root, 'link-to-repo');
    // a junction needs no privilege on Windows; on POSIX the type is ignored
    symlinkSync(repo, link, 'junction');
    const entries = await new RemoteWorktreeService(transport).list(link);
    expect(entries.map((e) => e.path)).toContain(join(repo, '.worktrees', 'task-7'));
    expect(entries.some((e) => e.path.startsWith(link))).toBe(false);
    rmSync(link, { recursive: true, force: true });
  });

  it('discovers repositories under a directory, with the toplevel in the host spelling', async () => {
    const repos = await new RepoDiscoveryService(factory).discover(server, root);
    const main = repos.find((r) => r.absolutePath === repo);
    expect(main?.relativePath).toBe('my repo 日本語');
    // the worktree under .worktrees has a `.git` file and is found too
    expect(repos.map((r) => r.relativePath)).toContain(join('my repo 日本語', '.worktrees', 'task-7'));
  });
});
