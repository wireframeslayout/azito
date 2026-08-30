import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoDiscoveryService, toDiscoveryResponse } from './RepoDiscoveryService';
import { normalizeRemoteUrl } from './parseRemoteUrl';
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

  it('propagates a nonzero `git --version` precheck as an error instead of an empty result (Issue #19 review round 2/3, Important finding 1)', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        return { stdout: '/work/repo/.git\n', stderr: '', code: 0 };
      }
      if (cmd.startsWith('git --version')) {
        // Simulates `git` being unavailable on the target. This is now
        // checked as its own independent command specifically so the
        // failure is unconditional (not dependent on which candidate the
        // batch happened to run last — see the position-independence
        // test below).
        return { stdout: '', stderr: 'bash: git: command not found', code: 127 };
      }
      throw new Error('should not reach the batch step once the git precheck failed');
    });

    const service = new RepoDiscoveryService(tmux);
    await expect(service.discover(makeServer(), '/work')).rejects.toThrow(/remote lookup failed/i);
  });

  it('propagates a nonzero batch exit code (transport-level failure) as an error instead of an empty result', async () => {
    const tmux = makeTmux(async (cmd) => {
      if (cmd.startsWith('find')) {
        return { stdout: '/work/repo/.git\n', stderr: '', code: 0 };
      }
      if (cmd.startsWith('git --version')) {
        return { stdout: 'git version 2.43.0', stderr: '', code: 0 };
      }
      // The batched rev-parse+remote-v command itself failed to run at
      // the transport level (every per-candidate group now ends in
      // `|| true`, so this can no longer be caused by an individual
      // candidate's git failure).
      return { stdout: '', stderr: 'transport error', code: 1 };
    });

    const service = new RepoDiscoveryService(tmux);
    await expect(service.discover(makeServer(), '/work')).rejects.toThrow(/remote lookup failed/i);
  });

  describe('a broken candidate within the batch does not depend on its position (Issue #19 review round 3, Important finding 1)', () => {
    // Chosen semantics: a single broken/unreadable candidate is dropped
    // from the result (its `rev-parse` produces no absolute path, so
    // `parseBatchOutput` skips it) while every other candidate is still
    // returned normally — the scan as a whole does not fail. This must
    // hold no matter where in the batch the broken candidate falls,
    // since `find`'s output order is filesystem-dependent.

    function makeBrokenBatchTmux(brokenPosition: 'first' | 'last') {
      const goodSection = [
        '---AZITO_REPO_SECTION---',
        '/work/good-repo',
        'origin\thttps://github.com/acme/widgets.git (fetch)',
      ].join('\n');
      // A broken candidate: `rev-parse` fails (2>/dev/null swallows
      // stderr), so its section has no leading absolute path line.
      const brokenSection = '---AZITO_REPO_SECTION---';

      const sections = brokenPosition === 'first' ? [brokenSection, goodSection] : [goodSection, brokenSection];
      const batchStdout = sections.join('\n');

      return makeTmux(async (cmd) => {
        if (cmd.startsWith('find')) {
          const paths =
            brokenPosition === 'first'
              ? '/work/broken-repo/.git\n/work/good-repo/.git\n'
              : '/work/good-repo/.git\n/work/broken-repo/.git\n';
          return { stdout: paths, stderr: '', code: 0 };
        }
        if (cmd.startsWith('git --version')) {
          return { stdout: 'git version 2.43.0', stderr: '', code: 0 };
        }
        // Every per-candidate group in the real command ends with
        // `|| true`, so the aggregate exit code is always 0 regardless
        // of which candidate is broken or where it sits in the chain.
        return { stdout: batchStdout, stderr: '', code: 0 };
      });
    }

    it('drops only the broken candidate when it is FIRST in the batch', async () => {
      const service = new RepoDiscoveryService(makeBrokenBatchTmux('first'));
      const repos = await service.discover(makeServer(), '/work');
      expect(repos).toHaveLength(1);
      expect(repos[0].absolutePath).toBe('/work/good-repo');
    });

    it('drops only the broken candidate when it is LAST in the batch', async () => {
      const service = new RepoDiscoveryService(makeBrokenBatchTmux('last'));
      const repos = await service.discover(makeServer(), '/work');
      expect(repos).toHaveLength(1);
      expect(repos[0].absolutePath).toBe('/work/good-repo');
    });
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

  describe('checkPathStatus', () => {
    it('reports exists:false without an error for a path that does not exist', async () => {
      const tmux = makeTmux(async () => ({ stdout: '', stderr: '', code: 0 }));
      const service = new RepoDiscoveryService(tmux);

      const status = await service.checkPathStatus(makeServer(), '/does/not/exist');

      expect(status).toEqual({ exists: false, isGitRepository: false });
    });

    it('reports exists:true, isGitRepository:false for an existing non-git directory', async () => {
      const tmux = makeTmux(async () => ({ stdout: 'EXISTS\n', stderr: '', code: 0 }));
      const service = new RepoDiscoveryService(tmux);

      const status = await service.checkPathStatus(makeServer(), '/work/plain-dir');

      expect(status).toEqual({ exists: true, isGitRepository: false });
    });

    it('reports exists:true, isGitRepository:true when the path itself has a .git entry', async () => {
      const tmux = makeTmux(async () => ({ stdout: 'EXISTS\nISGIT\n', stderr: '', code: 0 }));
      const service = new RepoDiscoveryService(tmux);

      const status = await service.checkPathStatus(makeServer(), '/work/repo');

      expect(status).toEqual({ exists: true, isGitRepository: true });
    });

    it('throws (does not silently report exists:false) on a transport-level failure', async () => {
      const tmux = makeTmux(async () => ({ stdout: '', stderr: 'boom', code: 1 }));
      const service = new RepoDiscoveryService(tmux);

      await expect(service.checkPathStatus(makeServer(), '/work')).rejects.toThrow(/Path status check failed/);
    });
  });

  describe('toDiscoveryResponse', () => {
    it('strips embedded credentials and never includes a raw remote URL', () => {
      const result = toDiscoveryResponse(
        [
          {
            relativePath: '.',
            absolutePath: '/work/repo',
            remotes: [
              {
                name: 'origin',
                url: 'https://ghost:dummy-token@github.com/acme/widgets.git',
                parsed: { provider: 'github', owner: 'acme', repoName: 'widgets', host: 'github.com' },
              },
            ],
          },
        ],
        new Set(),
      );

      expect(result[0].remotes[0].url).toBe('https://github.com/acme/widgets.git');
      expect(result[0].remotes[0].url).not.toContain('dummy-token');
    });

    it('drops a remote sanitizeDiscoveredRemoteUrl cannot clean, rather than a placeholder string', () => {
      const result = toDiscoveryResponse(
        [
          {
            relativePath: '.',
            absolutePath: '/work/repo',
            remotes: [
              {
                name: 'origin',
                // Structurally malformed scheme:// value sanitizeDiscoveredRemoteUrl cannot parse.
                url: 'https://[bad',
                parsed: { provider: 'other', owner: null, repoName: null, host: null },
              },
            ],
          },
        ],
        new Set(),
      );

      expect(result[0].remotes).toEqual([]);
    });

    it('marks alreadyRegistered only when the normalized URL is present in existingUrls', () => {
      const repos = [
        {
          relativePath: '.',
          absolutePath: '/work/repo',
          remotes: [
            {
              name: 'origin',
              url: 'git@github.com:acme/widgets.git',
              parsed: { provider: 'github' as const, owner: 'acme', repoName: 'widgets', host: 'github.com' },
            },
          ],
        },
      ];

      const matched = toDiscoveryResponse(repos, new Set([normalizeRemoteUrl('git@github.com:acme/widgets.git')]));
      expect(matched[0].remotes[0].alreadyRegistered).toBe(true);

      // The project-independent create-project wizard endpoint always calls
      // this with an empty set (no project exists yet to register against),
      // and must never report true regardless of the discovered URL.
      const unmatched = toDiscoveryResponse(repos, new Set());
      expect(unmatched[0].remotes[0].alreadyRegistered).toBe(false);
    });
  });
});
