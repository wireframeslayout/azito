import { describe, it, expect } from 'vitest';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import type { IServerTransport, ExecResult } from '../servers/transport/ServerTransport';
import type { CommandResult, CommandSpec } from '../../shared/exec/commandSpec';
import { CommandSpawnError } from '../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, ok, specText } from '../../shared/exec/testing/commandTesting';

const WD = '/home/user/project';
const WT = `${WD}/.worktrees/task-1`;

type ExecResponder = (command: string) => ExecResult | Promise<ExecResult>;
type GitResponder = (spec: CommandSpec) => CommandResult | Promise<CommandResult>;

/** git goes through `run`, the file operations (mkdir / test / rm) still through `exec`. Both are recorded in order. */
function setup(onGit: GitResponder = () => ok(), onExec: ExecResponder = defaultExec()) {
  const gitCalls: CommandSpec[] = [];
  const execCalls: string[] = [];
  const transport = {
    run: async (spec: CommandSpec) => { gitCalls.push(spec); return onGit(spec); },
    exec: async (command: string) => { execCalls.push(command); return onExec(command); },
  } as unknown as IServerTransport;
  return { svc: new RemoteWorktreeService(transport), gitCalls, execCalls, gitTexts: () => gitCalls.map(specText) };
}

const execOk = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });

/** The stale-worktree check says "no"; the check after creation says "yes". */
function defaultExec(): ExecResponder {
  return (command) => {
    if (!command.startsWith('test -d')) return execOk();
    return execOk(command.includes('echo exists') ? 'no\n' : 'yes\n');
  };
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
    it('creates the worktree with the file operations on exec and git on run', async () => {
      const { svc, gitTexts, execCalls } = setup();
      const result = await svc.create(WD, 42, 'my-task', 'main');

      expect(result).toEqual({ path: `${WD}/.worktrees/task-42`, branch: 'task/42-my-task' });
      expect(execCalls[0]).toBe(`mkdir -p ${WD}/.worktrees`);
      expect(gitTexts()).toEqual([
        'git branch -D task/42-my-task',
        `git worktree add -b task/42-my-task ${WD}/.worktrees/task-42 main`,
      ]);
    });

    it('removes a stale worktree if the path exists, and falls back to prune and rm when removal fails', async () => {
      let tests = 0;
      const { svc, gitTexts, execCalls } = setup(
        (spec) => (spec.args[1] === 'remove' ? failed(128, 'fatal: not a worktree') : ok()),
        (command) => {
          if (command.startsWith('test -d')) return execOk(++tests === 1 ? 'exists\n' : 'yes\n');
          return execOk();
        },
      );
      await svc.create(WD, 1, 'slug', 'main');

      expect(gitTexts().slice(0, 2)).toEqual([`git worktree remove ${WT} --force`, 'git worktree prune']);
      expect(execCalls).toContain(`rm -rf ${WT}`);
    });

    it('does not prune or rm when the stale worktree was removed', async () => {
      let tests = 0;
      const { svc, gitTexts, execCalls } = setup(() => ok(), (command) => {
        if (command.startsWith('test -d')) return execOk(++tests === 1 ? 'exists\n' : 'yes\n');
        return execOk();
      });
      await svc.create(WD, 1, 'slug', 'main');
      expect(gitTexts()).not.toContain('git worktree prune');
      expect(execCalls.some((c) => c.startsWith('rm -rf'))).toBe(false);
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
      const { svc } = setup(() => ok(), (command) => execOk(command.startsWith('test -d') ? 'no\n' : ''));
      await expect(svc.create(WD, 1, 'slug', 'main')).rejects.toThrow('Worktree directory not found after creation');
    });

    it('does not read a git exit 0 with "error:" in its output as a failure', async () => {
      const { svc } = setup((spec) => (spec.args[1] === 'add' ? ok('', 'error: unable to rmdir something (non-fatal)') : ok()));
      await expect(svc.create(WD, 1, 'slug', 'main')).resolves.toBeDefined();
    });
  });

  describe('exists', () => {
    it('returns true when directory exists', async () => {
      const { svc } = setup(undefined, () => execOk('yes\n'));
      expect(await svc.exists(WT)).toBe(true);
    });

    it('returns false when directory does not exist', async () => {
      const { svc } = setup(undefined, () => execOk('no\n'));
      expect(await svc.exists(WT)).toBe(false);
    });

    it('returns false on transport error', async () => {
      const { svc } = setup(undefined, () => { throw new Error('connection failed'); });
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
    it('rejects unsafe workingDir in create', async () => {
      await expect(setup().svc.create('/tmp; rm -rf /', 1, 'slug', 'main')).rejects.toThrow('Unsafe workingDir');
    });

    it('rejects unsafe taskSlug in create', async () => {
      await expect(setup().svc.create(WD, 1, 'slug; echo pwned', 'main')).rejects.toThrow('Unsafe taskSlug');
    });

    it('rejects unsafe baseBranch in create', async () => {
      await expect(setup().svc.create(WD, 1, 'slug', 'main && echo pwned')).rejects.toThrow('Unsafe baseBranch');
    });

    it('rejects unsafe worktreePath in exists', async () => {
      await expect(setup().svc.exists('$(whoami)')).rejects.toThrow('Unsafe worktreePath');
    });

    it('allows valid paths and branch names', async () => {
      expect(await setup(undefined, () => execOk('no\n')).svc.exists('/home/user-1/my_project/path.name')).toBe(false);
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
  describe('a working directory that starts with ~', () => {
    const HOME = '/home/u';
    const TILDE_DIR = '~/ws/repo';
    const REAL_DIR = `${HOME}/ws/repo`;

    /** `cd -- "$HOME"'/ws/repo' && pwd -P` (the path resolver) answers like a host whose home is /home/u. */
    const resolverExec = (rest: ExecResponder = defaultExec()): ExecResponder => (command) => {
      if (command.startsWith('cd -- "$HOME"')) return execOk(`${HOME}${command.match(/'([^']*)' && pwd -P$/)![1]}\n`);
      return rest(command);
    };

    it('resolves it against the target host before listing: git runs in the absolute directory', async () => {
      const { svc, gitCalls, execCalls } = setup(() => ok('worktree /home/u/ws/repo\nHEAD abc\nbranch refs/heads/main\n\n'), resolverExec());
      await svc.list(TILDE_DIR);
      expect(execCalls[0]).toBe(`cd -- "$HOME"'/ws/repo' && pwd -P`);
      expect(gitCalls[0].cwd).toBe(REAL_DIR);
    });

    it('creates the worktree under the resolved directory, and returns its absolute path', async () => {
      const { svc, gitCalls, execCalls } = setup(() => ok(), resolverExec());
      const result = await svc.create(TILDE_DIR, 5, 'slug', 'main');

      expect(result.path).toBe(`${REAL_DIR}/.worktrees/task-5`);
      expect(execCalls).toContain(`mkdir -p ${REAL_DIR}/.worktrees`);
      expect(gitCalls.every((c) => c.cwd === REAL_DIR)).toBe(true);
      expect(gitCalls.at(-1)!.args).toEqual(['worktree', 'add', '-b', 'task/5-slug', `${REAL_DIR}/.worktrees/task-5`, 'main']);
      expect(JSON.stringify([gitCalls, execCalls.filter((c) => !c.startsWith('cd -- "$HOME"'))])).not.toContain('~');
    });

    it('resolves the worktree path too for remove, getBranch, getDiff and exists', async () => {
      const { svc, gitCalls } = setup(() => ok('b\n'), resolverExec(() => execOk('yes\n')));
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

    it('fails, rather than running git in a directory named "~", when the host cannot resolve it', async () => {
      const { svc, gitCalls } = setup(() => ok(), (command) => (command.startsWith('cd -- "$HOME"') ? { stdout: '', stderr: 'no such directory', code: 1 } : execOk()));
      await expect(svc.list(TILDE_DIR)).rejects.toThrow(/realpath failed/);
      expect(gitCalls).toHaveLength(0);
    });

    it('leaves an absolute directory alone (no resolution round trip)', async () => {
      const { svc, execCalls } = setup(() => ok('worktree /w\nHEAD a\nbranch refs/heads/main\n\n'));
      await svc.list('/w');
      expect(execCalls).toHaveLength(0);
    });
  });

  // Each migrated call is pinned to what the old shell string became: the argv a real sh makes of the old `git ...` part equals the new args.
  describe.skipIf(process.platform === 'win32')('argv is the same as the old shell strings', () => {
    it('matches every git command of the old implementation', async () => {
      const { svc, gitCalls } = setup(() => ok('a'.repeat(40)), (command) => execOk(command.startsWith('test -d') ? (command.includes('echo yes') ? 'yes\n' : 'exists\n') : ''));
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
