import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import type { IServerTransport, ExecResult } from '../servers/transport/ServerTransport';

function mockTransport(responses: ExecResult[]): IServerTransport {
  let callIndex = 0;
  return {
    exec: vi.fn(async () => {
      if (callIndex < responses.length) return responses[callIndex++];
      return { stdout: '', stderr: '', code: 0 };
    }),
    execTmux: vi.fn(),
    openTerminal: vi.fn(),
    createPaneStream: vi.fn(),
  } as unknown as IServerTransport;
}

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

describe('RemoteWorktreeService', () => {
  describe('list', () => {
    it('returns empty array when working directory is not a git repository', async () => {
      const transport = mockTransport([
        { stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', code: 128 },
      ]);
      const svc = new RemoteWorktreeService(transport);
      const result = await svc.list('/home/user/non-git-dir');
      expect(result).toEqual([]);
    });

    it('returns empty array when not-a-git-repository appears in stdout (SSH code 0)', async () => {
      const transport = mockTransport([
        { stdout: 'fatal: not a git repository (or any of the parent directories): .git\n', stderr: '', code: 0 },
      ]);
      const svc = new RemoteWorktreeService(transport);
      const result = await svc.list('/home/user/non-git-dir');
      expect(result).toEqual([]);
    });

    it('throws on other git errors', async () => {
      const transport = mockTransport([
        { stdout: '', stderr: 'fatal: invalid reference: bad-ref', code: 128 },
      ]);
      const svc = new RemoteWorktreeService(transport);
      await expect(svc.list('/home/user/project')).rejects.toThrow('Failed to list worktrees');
    });

    it('parses worktree list output', async () => {
      const porcelainOutput = 'worktree /home/user/project\nHEAD abc1234\nbranch refs/heads/main\n\n';
      const transport = mockTransport([ok(porcelainOutput)]);
      const svc = new RemoteWorktreeService(transport);
      const result = await svc.list('/home/user/project');
      expect(result.length).toBe(1);
      expect(result[0].branch).toBe('main');
    });
  });

  describe('create', () => {
    it('creates worktree on remote with correct commands', async () => {
      const transport = mockTransport([
        ok(),           // mkdir -p
        ok('no\n'),     // test -d (not exists)
        ok(),           // git branch -D (may throw, caught)
        ok(),           // git worktree add
      ]);
      let testDCallCount = 0;
      (transport.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
        if (cmd.includes('git branch -D')) throw new Error('branch not found');
        if (cmd.includes('test -d')) {
          testDCallCount++;
          if (testDCallCount === 1) return ok('no\n');
          return ok('yes\n');
        }
        return ok();
      });

      const svc = new RemoteWorktreeService(transport);
      const result = await svc.create('/home/user/project', 42, 'my-task', 'main');

      expect(result).toEqual({
        path: '/home/user/project/.worktrees/task-42',
        branch: 'task/42-my-task',
      });
      expect(transport.exec).toHaveBeenCalledWith('mkdir -p /home/user/project/.worktrees');
    });

    it('removes stale worktree if path exists', async () => {
      const calls: string[] = [];
      let testDCallCount = 0;
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('test -d')) {
            testDCallCount++;
            if (testDCallCount === 1) return ok('exists\n');
            return ok('yes\n');
          }
          if (cmd.includes('git branch -D')) throw new Error('no branch');
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      await svc.create('/home/user/project', 1, 'slug', 'main');

      expect(calls.some(c => c.includes('git worktree remove'))).toBe(true);
    });

    it('uses -b flag when branchName is specified but rev-parse returns fatal', async () => {
      const calls: string[] = [];
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('test -d') && cmd.includes('echo yes')) return ok('yes\n');
          if (cmd.includes('test -d')) return ok('no\n');
          if (cmd.includes('rev-parse --verify')) return ok('fatal: Needed a single revision\n');
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      const result = await svc.create('/home/user/project', 1, 'slug', 'main', 'feature/new-branch');

      expect(result.branch).toBe('feature/new-branch');
      expect(calls.some(c => c.includes('git worktree add -b feature/new-branch'))).toBe(true);
    });

    it('reuses the existing local branch when rev-parse --verify succeeds (code 0)', async () => {
      const calls: string[] = [];
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('test -d') && cmd.includes('echo yes')) return ok('yes\n');
          if (cmd.includes('test -d')) return ok('no\n');
          if (cmd.includes('rev-parse --verify')) return ok('a'.repeat(40) + '\n');
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      const result = await svc.create('/home/user/project', 1, 'slug', 'main', 'feature/existing-branch');

      expect(result.branch).toBe('feature/existing-branch');
      // Existing-branch path: plain `git worktree add <path> <branch>`, no `-b`.
      expect(calls.some(c => c.includes('git worktree add /home/user/project/.worktrees/task-1 feature/existing-branch'))).toBe(true);
      expect(calls.some(c => c.includes('git worktree add -b'))).toBe(false);
    });

    // Issue #87 third-party review, fourth pass, Important finding 2:
    // `hasGitError` now also treats a non-zero exit code as an error, on
    // top of the pre-existing `fatal:`/`error:` text scan. Branch-existence
    // checks here rely on `!hasGitError(...)`; a real `git rev-parse
    // --verify` failure always both exits non-zero AND prints a `fatal:`
    // line, so the two signals never disagree in practice — but this pins
    // down that a non-zero exit alone (without matching text, an
    // otherwise-untestable shape with real git) is still correctly treated
    // as "branch does not exist", not silently ignored.
    it('treats a non-zero rev-parse exit code as "branch does not exist" even without fatal:/error: text', async () => {
      const calls: string[] = [];
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('test -d') && cmd.includes('echo yes')) return ok('yes\n');
          if (cmd.includes('test -d')) return ok('no\n');
          if (cmd.includes('rev-parse --verify')) return { stdout: '', stderr: '', code: 128 };
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      const result = await svc.create('/home/user/project', 1, 'slug', 'main', 'feature/missing-branch');

      expect(result.branch).toBe('feature/missing-branch');
      expect(calls.some(c => c.includes('git worktree add -b feature/missing-branch'))).toBe(true);
    });

    it('throws when git worktree add outputs fatal error', async () => {
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('test -d')) return ok('no\n');
          if (cmd.includes('git branch -D')) throw new Error('no branch');
          if (cmd.includes('git worktree add')) return ok('fatal: \'task-1\' is already checked out at \'/other/path\'\n');
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/home/user/project', 1, 'slug', 'main'))
        .rejects.toThrow('git worktree add failed');
    });

    it('throws when git worktree add outputs error message', async () => {
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('test -d')) return ok('no\n');
          if (cmd.includes('git branch -D')) throw new Error('no branch');
          if (cmd.includes('git worktree add')) return ok('error: unknown switch `x\'\n');
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/home/user/project', 1, 'slug', 'main'))
        .rejects.toThrow('git worktree add failed');
    });

    it('throws when worktree directory does not exist after creation', async () => {
      let existsCallCount = 0;
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('git branch -D')) throw new Error('no branch');
          if (cmd.includes('test -d')) {
            existsCallCount++;
            if (existsCallCount === 1) return ok('no\n');
            return ok('no\n');
          }
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/home/user/project', 1, 'slug', 'main'))
        .rejects.toThrow('Worktree directory not found after creation');
    });

    it('throws when stderr contains fatal error', async () => {
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('test -d')) return ok('no\n');
          if (cmd.includes('git branch -D')) throw new Error('no branch');
          if (cmd.includes('git worktree add')) return { stdout: '', stderr: 'fatal: invalid reference: bad-ref', code: 1 };
          return ok();
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/home/user/project', 1, 'slug', 'main'))
        .rejects.toThrow('git worktree add failed');
    });
  });

  describe('exists', () => {
    it('returns true when directory exists', async () => {
      const transport = mockTransport([ok('yes\n')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.exists('/home/user/project/.worktrees/task-1')).toBe(true);
    });

    it('returns false when directory does not exist', async () => {
      const transport = mockTransport([ok('no\n')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.exists('/home/user/project/.worktrees/task-1')).toBe(false);
    });

    it('returns false on transport error', async () => {
      const transport = {
        exec: vi.fn(async () => { throw new Error('connection failed'); }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      expect(await svc.exists('/home/user/project/.worktrees/task-1')).toBe(false);
    });
  });

  describe('remove', () => {
    it('calls git worktree remove and prune', async () => {
      const transport = mockTransport([ok(), ok()]);
      const svc = new RemoteWorktreeService(transport);
      await svc.remove('/home/user/project', '/home/user/project/.worktrees/task-1');

      expect(transport.exec).toHaveBeenCalledTimes(2);
      expect(transport.exec).toHaveBeenCalledWith(expect.stringContaining('git worktree remove'));
      expect(transport.exec).toHaveBeenCalledWith(expect.stringContaining('git worktree prune'));
    });
  });

  describe('getBranch', () => {
    it('returns branch name', async () => {
      const transport = mockTransport([ok('task/42-my-task\n')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.getBranch('/home/user/project/.worktrees/task-42')).toBe('task/42-my-task');
    });

    it('returns null on empty output', async () => {
      const transport = mockTransport([ok('')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.getBranch('/home/user/project/.worktrees/task-42')).toBeNull();
    });

    it('returns null on error', async () => {
      const transport = {
        exec: vi.fn(async () => { throw new Error('fail'); }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.getBranch('/home/user/project/.worktrees/task-42')).toBeNull();
    });
  });

  describe('getDiff', () => {
    it('parses diff output into JSON', async () => {
      const diffOutput = 'M\tsrc/file1.ts\nA\tsrc/file2.ts\n';
      const transport = mockTransport([ok(diffOutput)]);
      const svc = new RemoteWorktreeService(transport);
      const result = await svc.getDiff('/home/user/project/.worktrees/task-42', 'main');

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed).toEqual([
        { status: 'M', file: 'src/file1.ts' },
        { status: 'A', file: 'src/file2.ts' },
      ]);
    });

    it('returns null when no changes', async () => {
      const transport = mockTransport([ok('')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.getDiff('/home/user/project/.worktrees/task-42', 'main')).toBeNull();
    });

    it('falls back to HEAD~1 on first diff failure', async () => {
      let callCount = 0;
      const transport = {
        exec: vi.fn(async (cmd: string) => {
          callCount++;
          if (callCount === 1) throw new Error('no merge base');
          return ok('A\tnew-file.ts\n');
        }),
        execTmux: vi.fn(),
        openTerminal: vi.fn(),
        createPaneStream: vi.fn(),
      } as unknown as IServerTransport;

      const svc = new RemoteWorktreeService(transport);
      const result = await svc.getDiff('/home/user/project/.worktrees/task-42', 'main');
      expect(result).not.toBeNull();
      expect(JSON.parse(result!)).toEqual([{ status: 'A', file: 'new-file.ts' }]);
    });
  });

  describe('input validation', () => {
    it('rejects unsafe workingDir in create', async () => {
      const transport = mockTransport([]);
      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/tmp; rm -rf /', 1, 'slug', 'main')).rejects.toThrow('Unsafe workingDir');
    });

    it('rejects unsafe taskSlug in create', async () => {
      const transport = mockTransport([]);
      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/home/user/project', 1, 'slug; echo pwned', 'main')).rejects.toThrow('Unsafe taskSlug');
    });

    it('rejects unsafe baseBranch in create', async () => {
      const transport = mockTransport([]);
      const svc = new RemoteWorktreeService(transport);
      await expect(svc.create('/home/user/project', 1, 'slug', 'main && echo pwned')).rejects.toThrow('Unsafe baseBranch');
    });

    it('rejects unsafe worktreePath in exists', async () => {
      const transport = mockTransport([]);
      const svc = new RemoteWorktreeService(transport);
      await expect(svc.exists('$(whoami)')).rejects.toThrow('Unsafe worktreePath');
    });

    it('allows valid paths with common characters', async () => {
      const transport = mockTransport([ok('no\n')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.exists('/home/user-1/my_project/path.name')).toBe(false);
    });

    it('allows valid branch names', async () => {
      const transport = mockTransport([ok('')]);
      const svc = new RemoteWorktreeService(transport);
      expect(await svc.getBranch('/home/user/project')).toBeNull();
    });
  });
});
