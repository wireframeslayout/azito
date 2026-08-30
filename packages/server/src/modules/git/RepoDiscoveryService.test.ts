import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoDiscoveryService } from './RepoDiscoveryService';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { ServerConfig } from '../servers/Server';

function makeServer(): ServerConfig {
  return {
    name: 'local',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    muxRuntime: 'tmux',
    sshHostFingerprint: null,
  } as unknown as ServerConfig;
}

function makeTmux(execCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  return { execCommand: vi.fn((_server: ServerConfig, cmd: string) => execCommand(cmd)) } as unknown as TmuxClient;
}

describe('RepoDiscoveryService', () => {
  it('detects a repository whose .git is a file (worktree), resolving its own toplevel', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        // A worktree's .git is a regular file, found via -type f.
        return { stdout: '/work/main-repo/.worktrees/feature-x/.git\n', stderr: '', code: 0 };
      }
      // Batched rev-parse + remote -v for the single candidate.
      return {
        stdout: [
          '---AZITO_REPO_SECTION---',
          '/work/main-repo/.worktrees/feature-x',
          'origin\thttps://github.com/acme/widgets.git (fetch)',
          'origin\thttps://github.com/acme/widgets.git (push)',
        ].join('\n'),
        stderr: '',
        code: 0,
      };
    });

    const service = new RepoDiscoveryService(tmux);
    const repos = await service.discover(makeServer(), '/work');

    expect(repos).toHaveLength(1);
    expect(repos[0].absolutePath).toBe('/work/main-repo/.worktrees/feature-x');
    expect(repos[0].relativePath).toBe('main-repo/.worktrees/feature-x');
    expect(repos[0].remotes).toEqual([
      expect.objectContaining({ name: 'origin', url: 'https://github.com/acme/widgets.git' }),
    ]);
  });

  it('dedupes when multiple candidates resolve to the same toplevel', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        return { stdout: '/work/repo/.git\n', stderr: '', code: 0 };
      }
      return {
        stdout: [
          '---AZITO_REPO_SECTION---',
          '/work/repo',
          'origin\tgit@github.com:acme/widgets.git (fetch)',
        ].join('\n'),
        stderr: '',
        code: 0,
      };
    });

    const service = new RepoDiscoveryService(tmux);
    const repos = await service.discover(makeServer(), '/work');
    expect(repos).toHaveLength(1);
  });

  it('propagates a find failure as an error instead of an empty result', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        return { stdout: '', stderr: 'find: /work: Permission denied', code: 1 };
      }
      throw new Error('should not reach remote fetch step');
    });

    const service = new RepoDiscoveryService(tmux);
    await expect(service.discover(makeServer(), '/work')).rejects.toThrow(/scan failed/i);
  });

  it('propagates a transport-level rejection from the find step', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        throw new Error('ssh connection lost');
      }
      throw new Error('should not reach remote fetch step');
    });

    const service = new RepoDiscoveryService(tmux);
    await expect(service.discover(makeServer(), '/work')).rejects.toThrow(/ssh connection lost/);
  });

  it('propagates a nonzero batch (remote lookup) exit code as an error instead of an empty result (Issue #19 review round 2, Important finding 1)', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        return { stdout: '/work/repo/.git\n', stderr: '', code: 0 };
      }
      // Simulates e.g. `git` being unavailable on the target: the batch
      // command's final step fails with a nonzero exit even though its
      // stdout looks like a well-formed (empty) result.
      return { stdout: '', stderr: 'bash: git: command not found', code: 127 };
    });

    const service = new RepoDiscoveryService(tmux);
    await expect(service.discover(makeServer(), '/work')).rejects.toThrow(/remote lookup failed/i);
  });

  it('returns an empty list when no .git entries are found', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      throw new Error('should not reach remote fetch step');
    });

    const service = new RepoDiscoveryService(tmux);
    const repos = await service.discover(makeServer(), '/work');
    expect(repos).toEqual([]);
  });

  describe('find command against a real filesystem fixture (Issue #19 later review round)', () => {
    let fixtureRoot: string;

    afterEach(() => {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    });

    /**
     * Excluding all hidden directories (a blanket "*" then "." then "*"
     * path pattern) silently excluded AZITO's own task worktrees, which
     * live under a hidden
     * `.worktrees/` directory — the previous exclusion made `find` never
     * see `.worktrees/task-1/.git` (a file, per a real worktree). This
     * test runs the ACTUAL `find` command the service builds (not a
     * mocked `tmux.execCommand`) against a real temp-directory fixture,
     * so a regression back to the over-broad hidden-directory exclusion
     * is caught even if every other test in this file keeps mocking
     * `execCommand`.
     */
    it('finds both a normal repo and a worktree .git under a hidden directory', async () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'azito-repo-discovery-'));

      // Normal clone: repo/.git is a directory.
      mkdirSync(join(fixtureRoot, 'repo', '.git'), { recursive: true });

      // AZITO-style task worktree: .worktrees/task-1/.git is a FILE
      // (a `gitdir: ...` pointer), under the hidden `.worktrees/` dir.
      mkdirSync(join(fixtureRoot, '.worktrees', 'task-1'), { recursive: true });
      writeFileSync(join(fixtureRoot, '.worktrees', 'task-1', '.git'), 'gitdir: ../../.git/worktrees/task-1\n');

      // Should still be excluded: node_modules, and the contents of an
      // already-matched .git directory (its internals are not
      // themselves a repository to report).
      mkdirSync(join(fixtureRoot, 'node_modules', 'somepkg', '.git'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'repo', '.git', 'modules', 'sub', '.git'), { recursive: true });

      let capturedFindCmd = '';
      const tmux = {
        execCommand: vi.fn(async (_server: ServerConfig, cmd: string) => {
          if (cmd.startsWith('find')) {
            capturedFindCmd = cmd;
            // Run the real command the service built, against the real
            // fixture directory — this is the crux of the regression test.
            const stdout = execSync(cmd, { shell: '/bin/bash' }).toString();
            return { stdout, stderr: '', code: 0 };
          }
          // Batched rev-parse + remote -v step: not what this test is
          // verifying, so return a minimal well-formed response per
          // candidate without actually invoking git.
          return { stdout: '', stderr: '', code: 0 };
        }),
      } as unknown as TmuxClient;

      const service = new RepoDiscoveryService(tmux);
      await service.discover(makeServer(), fixtureRoot);

      expect(capturedFindCmd).toContain('find ');
      const findOnly = execSync(capturedFindCmd, { shell: '/bin/bash' }).toString();
      const foundPaths = findOnly.split('\n').map((l) => l.trim()).filter(Boolean);

      expect(foundPaths).toContain(join(fixtureRoot, 'repo', '.git'));
      expect(foundPaths).toContain(join(fixtureRoot, '.worktrees', 'task-1', '.git'));
      expect(foundPaths.some((p) => p.includes('node_modules'))).toBe(false);
      expect(foundPaths.some((p) => p.includes('/.git/modules/'))).toBe(false);
    });
  });
});
