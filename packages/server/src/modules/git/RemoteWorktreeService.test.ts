import { describe, it, expect } from 'vitest';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import type { CommandResult, CommandSpec } from '../../shared/exec/commandSpec';
import { CommandSpawnError } from '../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, ok, specText } from '../../shared/exec/testing/commandTesting';

const WD = '/home/user/project';
const WT = `${WD}/.worktrees/task-1`;

type GitResponder = (spec: CommandSpec) => CommandResult | Promise<CommandResult>;

/** What the host's file operations say about a path (is there a directory?), and how it resolves `~`. */
interface FilesModel {
  /** Whether `path` is a directory, given how many times it has been asked about (the default: not before the worktree is created, there after). */
  isDirectory: (path: string, asked: number) => boolean;
  /** The home directory `~` resolves to; undefined: the host cannot resolve it. */
  home: string | undefined;
  /** A path the host cannot resolve (it is gone). */
  unresolvable: (path: string) => boolean;
}

const defaultFiles = (): FilesModel => ({ isDirectory: (_p, asked) => asked > 0, home: undefined, unresolvable: () => false });

function fakeFiles(model: FilesModel, calls: string[]): IFileOps {
  const asked = new Map<string, number>();
  return {
    platform: 'linux',
    create: async (p: string) => { calls.push(`create ${p}`); return { created: true }; },
    remove: async (p: string) => { calls.push(`remove ${p}`); },
    stat: async (p: string) => {
      calls.push(`stat ${p}`);
      const n = asked.get(p) ?? 0;
      asked.set(p, n + 1);
      return model.isDirectory(p, n) ? { kind: 'directory', size: 0, mtimeMs: 0, mode: 0o755 } : null;
    },
    realpath: async (p: string) => {
      calls.push(`realpath ${p}`);
      if (model.unresolvable(p) || ((p === '~' || p.startsWith('~/')) && model.home === undefined)) throw new FileOpsError('NOT_FOUND', `realpath failed for '${p}'`);
      return p === '~' || p.startsWith('~/') ? `${model.home}${p.slice(1)}` : p;
    },
  } as unknown as IFileOps;
}

/** git goes through `run`, the file operations (mkdir / test / rm / realpath) through the host's `files()`. Both are recorded in order. */
function setup(onGit: GitResponder = () => ok(), files: Partial<FilesModel> = {}) {
  const gitCalls: CommandSpec[] = [];
  const fileCalls: string[] = [];
  const hostFiles = fakeFiles({ ...defaultFiles(), ...files }, fileCalls);
  const transport = {
    run: async (spec: CommandSpec) => { gitCalls.push(spec); return onGit(spec); },
    files: () => hostFiles,
  } as unknown as IServerTransport;
  return { svc: new RemoteWorktreeService(transport), gitCalls, fileCalls, gitTexts: () => gitCalls.map(specText) };
}

describe('RemoteWorktreeService', () => {
  describe('list', () => {
    it('runs git in the working directory as cwd', async () => {
      const { svc, gitCalls } = setup(() => ok('worktree /home/user/project\nHEAD abc1234\nbranch refs/heads/main\n\n'));
      const result = await svc.list(WD);
      expect(result).toHaveLength(1);
      expect(result[0].branch).toBe('main');
      expect(gitCalls).toHaveLength(1);
      expect(gitCalls[0]).toMatchObject({ file: 'git', args: ['worktree', 'list', '--porcelain'], cwd: WD });
    });

    it('returns empty array when working directory is not a git repository', async () => {
      const { svc } = setup(() => failed(128, 'fatal: not a git repository (or any of the parent directories): .git\n'));
      expect(await svc.list('/home/user/non-git-dir')).toEqual([]);
    });

    it('throws on other git errors', async () => {
      const { svc } = setup(() => failed(128, 'fatal: invalid reference: bad-ref'));
      await expect(svc.list(WD)).rejects.toThrow('Failed to list worktrees');
    });

    it('lets a program that cannot start propagate instead of reporting an empty list', async () => {
      const { svc } = setup(() => { throw new CommandSpawnError('ENOENT', 'spawn git ENOENT'); });
      await expect(svc.list(WD)).rejects.toBeInstanceOf(CommandSpawnError);
    });
  });

  describe('create', () => {
    it('creates the worktree with the file operations on the host and git on run', async () => {
      const { svc, gitTexts, fileCalls } = setup();
      const result = await svc.create(WD, 42, 'my-task', 'main');

      expect(result).toEqual({ path: `${WD}/.worktrees/task-42`, branch: 'task/42-my-task' });
      expect(fileCalls.slice(0, 2)).toEqual([`realpath ${WD}`, `create ${WD}/.worktrees`]);
      expect(gitTexts()).toEqual([
        'git branch -D task/42-my-task',
        `git worktree add -b task/42-my-task ${WD}/.worktrees/task-42 main`,
      ]);
    });

    it('removes a stale worktree if the path exists, and falls back to prune and rm when removal fails', async () => {
      const { svc, gitTexts, fileCalls } = setup(
        (spec) => (spec.args[1] === 'remove' ? failed(128, 'fatal: not a worktree') : ok()),
        { isDirectory: () => true },
      );
      await svc.create(WD, 1, 'slug', 'main');

      expect(gitTexts().slice(0, 2)).toEqual([`git worktree remove ${WT} --force`, 'git worktree prune']);
      expect(fileCalls).toContain(`remove ${WT}`);
    });

    it('does not prune or rm when the stale worktree was removed', async () => {
      const { svc, gitTexts, fileCalls } = setup(() => ok(), { isDirectory: () => true });
      await svc.create(WD, 1, 'slug', 'main');
      expect(gitTexts()).not.toContain('git worktree prune');
      expect(fileCalls.some((c) => c.startsWith('remove'))).toBe(false);
    });

    it('uses -b when branchName is specified and neither the local nor the remote branch exists', async () => {
      const { svc, gitTexts } = setup((spec) => (spec.args[0] === 'rev-parse' ? failed(128, 'fatal: Needed a single revision') : ok()));
      const result = await svc.create(WD, 1, 'slug', 'main', 'feature/new-branch');

      expect(result.branch).toBe('feature/new-branch');
      expect(gitTexts()).toEqual([
        'git rev-parse --verify feature/new-branch',
        'git rev-parse --verify origin/feature/new-branch',
        `git worktree add -b feature/new-branch ${WT} main`,
      ]);
    });

    it('reuses the existing local branch when rev-parse --verify exits 0', async () => {
      const { svc, gitTexts } = setup((spec) => (spec.args[0] === 'rev-parse' ? ok('a'.repeat(40) + '\n') : ok()));
      const result = await svc.create(WD, 1, 'slug', 'main', 'feature/existing-branch');

      expect(result.branch).toBe('feature/existing-branch');
      expect(gitTexts()).toEqual([
        'git rev-parse --verify feature/existing-branch',
        `git worktree add ${WT} feature/existing-branch`,
      ]);
    });

    it('uses the remote branch when only origin/<branch> exists', async () => {
      const { svc, gitTexts } = setup((spec) => (spec.args[0] === 'rev-parse' && spec.args[2] === 'feature/x' ? failed(128) : ok()));
      await svc.create(WD, 1, 'slug', 'main', 'feature/x');
      expect(gitTexts()[2]).toBe(`git worktree add ${WT} feature/x`);
    });

    it('treats the exit code alone as "branch does not exist", with no text in the output', async () => {
      const { svc, gitTexts } = setup((spec) => (spec.args[0] === 'rev-parse' ? failed(128) : ok()));
      await svc.create(WD, 1, 'slug', 'main', 'feature/missing-branch');
      expect(gitTexts()).toContain(`git worktree add -b feature/missing-branch ${WT} main`);
    });

    it('prunes and retries, then forces, when the branch is already used by another worktree', async () => {
      let adds = 0;
      const { svc, gitTexts } = setup((spec) => {
        if (spec.args[0] === 'worktree' && spec.args[1] === 'add') {
          adds++;
          return failed(128, "fatal: 'feature/x' is already used by worktree at '/old'");
        }
        return ok();
      });
      await expect(svc.create(WD, 1, 'slug', 'main', 'feature/x')).rejects.toThrow('git worktree add failed');
      expect(adds).toBe(3);
      expect(gitTexts().slice(-4)).toEqual([
        `git worktree add ${WT} feature/x`,
        'git worktree prune',
        `git worktree add ${WT} feature/x`,
        `git worktree add --force ${WT} feature/x`,
      ]);
    });

    it('throws with git\'s message when worktree add fails', async () => {
      const { svc } = setup((spec) => (spec.args[1] === 'add' ? failed(128, "fatal: invalid reference: bad-ref") : ok()));
      await expect(svc.create(WD, 1, 'slug', 'main')).rejects.toThrow('git worktree add failed: fatal: invalid reference: bad-ref');
    });

    it('throws when worktree directory does not exist after creation', async () => {
      const { svc } = setup(() => ok(), { isDirectory: () => false });
      await expect(svc.create(WD, 1, 'slug', 'main')).rejects.toThrow('Worktree directory not found after creation');
    });

    it('does not read a git exit 0 with "error:" in its output as a failure', async () => {
      const { svc } = setup((spec) => (spec.args[1] === 'add' ? ok('', 'error: unable to rmdir something (non-fatal)') : ok()));
      await expect(svc.create(WD, 1, 'slug', 'main')).resolves.toBeDefined();
    });
  });

  describe('exists', () => {
    it('returns true when directory exists', async () => {
      const { svc } = setup(undefined, { isDirectory: () => true });
      expect(await svc.exists(WT)).toBe(true);
    });

    it('returns false when directory does not exist', async () => {
      const { svc } = setup(undefined, { isDirectory: () => false });
      expect(await svc.exists(WT)).toBe(false);
    });

    it('returns false on transport error', async () => {
      const { svc } = setup(undefined, { isDirectory: () => { throw new Error('connection failed'); } });
      expect(await svc.exists(WT)).toBe(false);
    });
  });

  describe('remove', () => {
    it('runs worktree remove and prune in the working directory', async () => {
      const { svc, gitCalls } = setup();
      await svc.remove(WD, WT);
      expect(gitCalls.map((c) => c.args)).toEqual([['worktree', 'remove', WT, '--force'], ['worktree', 'prune']]);
      expect(gitCalls.every((c) => c.cwd === WD)).toBe(true);
    });

    it('still prunes when remove fails', async () => {
      const { svc, gitTexts } = setup((spec) => (spec.args[1] === 'remove' ? failed(128) : ok()));
      await svc.remove(WD, WT);
      expect(gitTexts()).toEqual([`git worktree remove ${WT} --force`, 'git worktree prune']);
    });
  });

  describe('getBranch', () => {
    it('returns branch name', async () => {
      const { svc, gitCalls } = setup(() => ok('task/42-my-task\n'));
      expect(await svc.getBranch(`${WD}/.worktrees/task-42`)).toBe('task/42-my-task');
      expect(gitCalls[0].args).toEqual(['-C', `${WD}/.worktrees/task-42`, 'branch', '--show-current']);
      expect(gitCalls[0].cwd).toBeUndefined();
    });

    it('returns null on empty output', async () => {
      const { svc } = setup(() => ok(''));
      expect(await svc.getBranch(WT)).toBeNull();
    });

    it('returns null on a non-zero exit and on error', async () => {
      expect(await setup(() => failed(128, 'fatal: not a git repository')).svc.getBranch(WT)).toBeNull();
      expect(await setup(() => { throw new Error('fail'); }).svc.getBranch(WT)).toBeNull();
    });
  });

  describe('getDiff', () => {
    it('parses diff output into JSON', async () => {
      const { svc, gitCalls } = setup(() => ok('M\tsrc/file1.ts\nA\tsrc/file2.ts\n'));
      const result = await svc.getDiff(WT, 'main');
      expect(JSON.parse(result!)).toEqual([
        { status: 'M', file: 'src/file1.ts' },
        { status: 'A', file: 'src/file2.ts' },
      ]);
      expect(gitCalls[0].args).toEqual(['-c', 'core.quotepath=false', '-C', WT, 'diff', '--name-status', 'main...HEAD']);
    });

    it('returns null when no changes', async () => {
      expect(await setup(() => ok('')).svc.getDiff(WT, 'main')).toBeNull();
    });

    it('falls back to HEAD~1 when the first diff exits non-zero', async () => {
      const { svc, gitCalls } = setup((spec) => (spec.args.includes('main...HEAD') ? failed(128, 'fatal: no merge base') : ok('A\tnew-file.ts\n')));
      const result = await svc.getDiff(WT, 'main');
      expect(JSON.parse(result!)).toEqual([{ status: 'A', file: 'new-file.ts' }]);
      expect(gitCalls[1].args.at(-1)).toBe('HEAD~1');
    });

    it('returns null when both diffs fail', async () => {
      expect(await setup(() => failed(128)).svc.getDiff(WT, 'main')).toBeNull();
    });
  });

  describe('input validation', () => {
    it.each(['relative/dir', '--upload-pack=x', '/tmp/a\nb', ''])('rejects the workingDir %j in create, before git runs', async (dir) => {
      const { svc, gitCalls } = setup();
      await expect(svc.create(dir, 1, 'slug', 'main')).rejects.toThrow('Unsafe workingDir');
      expect(gitCalls).toHaveLength(0);
    });

    it('takes shell metacharacters, spaces and Japanese in a path as plain characters: git gets an argv, never a shell line', async () => {
      const dir = "/home/u/my repo 日本語/it's $(id);`x`";
      const { svc, gitCalls } = setup();
      const result = await svc.create(dir, 1, 'slug', 'main');
      expect(result.path).toBe(`${dir}/.worktrees/task-1`);
      expect(gitCalls.at(-1)!.args).toEqual(['worktree', 'add', '-b', 'task/1-slug', `${dir}/.worktrees/task-1`, 'main']);
      expect(gitCalls.every((c) => c.cwd === dir)).toBe(true);
    });

    it('rejects unsafe taskSlug in create', async () => {
      await expect(setup().svc.create(WD, 1, 'slug; echo pwned', 'main')).rejects.toThrow('Unsafe taskSlug');
    });

    it('rejects unsafe baseBranch in create', async () => {
      await expect(setup().svc.create(WD, 1, 'slug', 'main && echo pwned')).rejects.toThrow('Unsafe baseBranch');
    });

    it('rejects a relative worktreePath in exists', async () => {
      await expect(setup().svc.exists('$(whoami)')).rejects.toThrow('Unsafe worktreePath');
    });

    it('allows valid paths and branch names', async () => {
      expect(await setup(undefined, { isDirectory: () => false }).svc.exists('/home/user-1/my_project/path.name')).toBe(false);
      expect(await setup(() => ok('')).svc.getBranch(WD)).toBeNull();
    });

    it.each([
      ['baseBranch', (svc: RemoteWorktreeService) => svc.create(WD, 1, 'slug', '--help')],
      ['branchName', (svc: RemoteWorktreeService) => svc.create(WD, 1, 'slug', 'main', '--force')],
      ['worktreePath', (svc: RemoteWorktreeService) => svc.remove(WD, '-rf')],
      ['baseBranch in getDiff', (svc: RemoteWorktreeService) => svc.getDiff(WT, '--output=x')],
    ])('refuses a value git would read as an option: %s', async (_label, call) => {
      const { svc, gitCalls } = setup();
      await expect(call(svc)).rejects.toThrow(/Unsafe/);
      expect(gitCalls).toHaveLength(0);
    });

    // Issue #87 third-party review, 12th round: `assertSafeBranch` runs against PERSISTED values, so a task saved before the API
    // boundary rejected `refs/...` input must still run.
    it('does not reject a fully-qualified ref (refs/heads/main) as baseBranch — back-compat for persisted values', async () => {
      await expect(setup().svc.create(WD, 1, 'slug', 'refs/heads/main')).resolves.toBeDefined();
    });

    it('does not reject a fully-qualified ref (refs/heads/main) as branchName — back-compat for persisted task.branch values', async () => {
      const { svc } = setup((spec) => (spec.args[0] === 'rev-parse' ? failed(128) : ok()));
      const result = await svc.create(WD, 1, 'slug', 'main', 'refs/heads/main');
      expect(result.branch).toBe('refs/heads/main');
    });

    it('still rejects a baseBranch containing shell metacharacters, refs/-qualified or not', async () => {
      await expect(setup().svc.create(WD, 1, 'slug', 'refs/heads/main; rm -rf /')).rejects.toThrow('Unsafe baseBranch');
    });
  });

  // `~/...` is a supported form of a stored working directory. The shell used to expand it; `cwd` and git's arguments are literal.
  describe('a Windows host', () => {
    const WIN_HOME = 'C:\\Users\\me';
    const WIN_WD = 'D:\\work\\my repo 日本語';
    const WIN_WT = `${WIN_WD}\\.worktrees\\task-1`;

    function winSetup(onGit: GitResponder = () => ok()) {
      const gitCalls: CommandSpec[] = [];
      const fileCalls: string[] = [];
      const files = {
        platform: 'win32',
        create: async (p: string) => { fileCalls.push(`create ${p}`); return { created: true }; },
        remove: async (p: string) => { fileCalls.push(`remove ${p}`); },
        stat: async (p: string) => { fileCalls.push(`stat ${p}`); return fileCalls.filter((c) => c === `stat ${p}`).length > 1 ? { kind: 'directory', size: 0, mtimeMs: 0, mode: 0 } : null; },
        realpath: async (p: string) => { fileCalls.push(`realpath ${p}`); return p === '~' || p.startsWith('~\\') || p.startsWith('~/') ? `${WIN_HOME}${p.slice(1).replace(/\//g, '\\')}` : p; },
      } as unknown as IFileOps;
      const transport = { run: async (spec: CommandSpec) => { gitCalls.push(spec); return onGit(spec); }, files: () => files } as unknown as IServerTransport;
      return { svc: new RemoteWorktreeService(transport), gitCalls, fileCalls };
    }

    it('builds the worktree path with backslashes', async () => {
      const { svc, gitCalls, fileCalls } = winSetup();
      const result = await svc.create(WIN_WD, 1, 'slug', 'main');
      expect(result.path).toBe(WIN_WT);
      expect(fileCalls).toContain(`create ${WIN_WD}\\.worktrees`);
      expect(gitCalls.at(-1)!.args).toEqual(['worktree', 'add', '-b', 'task/1-slug', WIN_WT, 'main']);
      expect(gitCalls.every((c) => c.cwd === WIN_WD)).toBe(true);
    });

    it('resolves ~\\ and ~/ against the host home, and builds the worktree under it', async () => {
      for (const tilde of ['~\\repo', '~/repo']) {
        const { svc, gitCalls } = winSetup();
        const result = await svc.create(tilde, 2, 'slug', 'main');
        expect(result.path).toBe(`${WIN_HOME}\\repo\\.worktrees\\task-2`);
        expect(gitCalls.every((c) => c.cwd === `${WIN_HOME}\\repo`)).toBe(true);
      }
    });

    it('remove keeps the working directory prefix for a worktree below it, whichever slash the stored path uses', async () => {
      const { svc, gitCalls } = winSetup();
      await svc.remove('~\\repo', '~/repo/.worktrees/task-3');
      expect(gitCalls.map((c) => c.args)).toEqual([
        ['worktree', 'remove', `${WIN_HOME}\\repo\\.worktrees\\task-3`, '--force'],
        ['worktree', 'prune'],
      ]);
    });

    it('refuses a POSIX path, a drive-relative path and a device path', async () => {
      const { svc, gitCalls } = winSetup();
      await expect(svc.create('/home/me/repo', 1, 'slug', 'main')).rejects.toThrow('Unsafe workingDir');
      await expect(svc.exists('C:foo')).rejects.toThrow('Unsafe worktreePath');
      await expect(svc.getBranch('\\\\?\\C:\\x')).rejects.toThrow('Unsafe worktreePath');
      expect(gitCalls).toHaveLength(0);
    });
  });

  describe('a working directory that starts with ~', () => {
    const HOME = '/home/u';
    const TILDE_DIR = '~/ws/repo';
    const REAL_DIR = `${HOME}/ws/repo`;

    it('resolves it against the target host before listing: git runs in the absolute directory', async () => {
      const { svc, gitCalls, fileCalls } = setup(() => ok('worktree /home/u/ws/repo\nHEAD abc\nbranch refs/heads/main\n\n'), { home: HOME });
      await svc.list(TILDE_DIR);
      expect(fileCalls[0]).toBe(`realpath ${TILDE_DIR}`);
      expect(gitCalls[0].cwd).toBe(REAL_DIR);
    });

    it('creates the worktree under the resolved directory, and returns its absolute path', async () => {
      const { svc, gitCalls, fileCalls } = setup(() => ok(), { home: HOME });
      const result = await svc.create(TILDE_DIR, 5, 'slug', 'main');

      expect(result.path).toBe(`${REAL_DIR}/.worktrees/task-5`);
      expect(fileCalls).toContain(`create ${REAL_DIR}/.worktrees`);
      expect(gitCalls.every((c) => c.cwd === REAL_DIR)).toBe(true);
      expect(gitCalls.at(-1)!.args).toEqual(['worktree', 'add', '-b', 'task/5-slug', `${REAL_DIR}/.worktrees/task-5`, 'main']);
      expect(JSON.stringify([gitCalls, fileCalls.filter((c) => !c.startsWith('realpath'))])).not.toContain('~');
    });

    it('resolves the worktree path too for remove, getBranch, getDiff and exists', async () => {
      const { svc, gitCalls } = setup(() => ok('b\n'), { home: HOME, isDirectory: () => true });
      const worktree = '~/ws/repo/.worktrees/task-1';
      await svc.remove(TILDE_DIR, worktree);
      await svc.getBranch(worktree);
      await svc.getDiff(worktree, 'main');
      expect(await svc.exists(worktree)).toBe(true);

      const real = `${REAL_DIR}/.worktrees/task-1`;
      expect(gitCalls.map((c) => c.args)).toEqual([
        ['worktree', 'remove', real, '--force'],
        ['worktree', 'prune'],
        ['-C', real, 'branch', '--show-current'],
        ['-c', 'core.quotepath=false', '-C', real, 'diff', '--name-status', 'main...HEAD'],
      ]);
      expect(gitCalls.slice(0, 2).every((c) => c.cwd === REAL_DIR)).toBe(true);
    });

    it('only prunes when a stored ~ worktree path cannot be resolved because the directory is already gone', async () => {
      const { svc, gitCalls } = setup(() => failed(128, 'fatal: not a working tree'), { home: HOME, unresolvable: (p) => p.includes('.worktrees') });
      await svc.remove(TILDE_DIR, '~/ws/repo/.worktrees/task-9');
      expect(gitCalls.map((c) => [c.args, c.cwd])).toEqual([[['worktree', 'prune'], REAL_DIR]]);
    });

    it('fails, rather than running git in a directory named "~", when the host cannot resolve it', async () => {
      const { svc, gitCalls } = setup(() => ok(), { home: undefined });
      await expect(svc.list(TILDE_DIR)).rejects.toThrow(/realpath failed/);
      expect(gitCalls).toHaveLength(0);
    });

    it('leaves an absolute directory alone (no resolution round trip)', async () => {
      const { svc, fileCalls } = setup(() => ok('worktree /w\nHEAD a\nbranch refs/heads/main\n\n'));
      await svc.list('/w');
      expect(fileCalls).toHaveLength(0);
    });
  });

  // Each migrated call is pinned to what the old shell string became: the argv a real sh makes of the old `git ...` part equals the new args.
  describe.skipIf(process.platform === 'win32')('argv is the same as the old shell strings', () => {
    it('matches every git command of the old implementation', async () => {
      const { svc, gitCalls } = setup(() => ok('a'.repeat(40)), { isDirectory: () => true });
      await svc.create(WD, 1, 'slug', 'main', 'feature/x');
      await svc.remove(WD, WT);
      await svc.getBranch(WT);
      await svc.getDiff(WT, 'main');
      await svc.list(WD);

      const expected = [
        `git worktree remove ${WT} --force`,
        `git rev-parse --verify feature/x`,
        `git worktree add ${WT} feature/x`,
        `git worktree remove ${WT} --force`,
        `git worktree prune`,
        `git -C ${WT} branch --show-current`,
        `git -c core.quotepath=false -C ${WT} diff --name-status main...HEAD`,
        `git worktree list --porcelain`,
      ];
      expect(gitCalls.map(argvOfSpec)).toEqual(expected.map(argvOfShellLine));
    });
  });
});
