import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoDiscoveryService, toDiscoveryResponse } from './RepoDiscoveryService';
import { normalizeRemoteUrl } from './parseRemoteUrl';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import { CommandSpawnError, CommandTimeoutError, type CommandResult, type CommandSpec } from '../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, ok } from '../../shared/exec/testing/commandTesting';

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

type ExecAnswer = { stdout: string; stderr: string; code: number };

/**
 * `find` and the path check are shell file operations (exec); every git command goes through `run`. Calls are recorded in order.
 */
function makeTransportFactory(
  exec: (cmd: string) => Promise<ExecAnswer>,
  git: (spec: CommandSpec) => CommandResult | Promise<CommandResult> = () => ok(),
) {
  const gitSpecs: CommandSpec[] = [];
  const transport = {
    exec: vi.fn((cmd: string) => exec(cmd)),
    run: vi.fn(async (spec: CommandSpec) => { gitSpecs.push(spec); return git(spec); }),
  };
  return { factory: { getTransport: () => transport } as unknown as TransportFactory, gitSpecs };
}

const findAnswer = (stdout: string): ExecAnswer => ({ stdout, stderr: '', code: 0 });
const noExec = async (): Promise<ExecAnswer> => { throw new Error('exec should not have been called'); };

/** Answers `git --version`, then per candidate directory (`-C <dir>`) the toplevel and the remotes. */
function gitFor(repos: Record<string, { toplevel?: string; remotes?: string[]; remoteFails?: boolean }>) {
  return (spec: CommandSpec): CommandResult => {
    if (spec.args[0] === '--version') return ok('git version 2.43.0\n');
    const dir = spec.args[1];
    const repo = repos[dir];
    if (!repo) throw new Error(`unexpected candidate ${dir}`);
    if (spec.args[2] === 'rev-parse') return repo.toplevel ? ok(`${repo.toplevel}\n`) : failed(128, 'fatal: not a git repository');
    if (repo.remoteFails) return failed(1, 'error');
    return ok((repo.remotes ?? []).join('\n'));
  };
}

describe('RepoDiscoveryService', () => {
  it('detects a repository whose .git is a file (worktree), resolving its own toplevel', async () => {
    const wt = '/work/main-repo/.worktrees/feature-x';
    const { factory, gitSpecs } = makeTransportFactory(
      async (cmd) => {
        expect(cmd.startsWith('find')).toBe(true);
        // A worktree's .git is a regular file, found via -type f.
        return findAnswer(`${wt}/.git\n`);
      },
      gitFor({
        [wt]: {
          toplevel: wt,
          remotes: ['origin\thttps://github.com/acme/widgets.git (fetch)', 'origin\thttps://github.com/acme/widgets.git (push)'],
        },
      }),
    );

    const repos = await new RepoDiscoveryService(factory).discover(makeServer(), '/work');

    expect(repos).toHaveLength(1);
    expect(repos[0].absolutePath).toBe(wt);
    expect(repos[0].relativePath).toBe('main-repo/.worktrees/feature-x');
    expect(repos[0].remotes).toEqual([
      expect.objectContaining({ name: 'origin', url: 'https://github.com/acme/widgets.git' }),
    ]);
    expect(gitSpecs.map((s) => s.args)).toEqual([
      ['--version'],
      ['-C', wt, 'rev-parse', '--show-toplevel'],
      ['-C', wt, 'remote', '-v'],
    ]);
  });

  it('dedupes when multiple candidates resolve to the same toplevel', async () => {
    const { factory } = makeTransportFactory(
      async () => findAnswer('/work/repo/.git\n/work/repo/sub/.git\n'),
      gitFor({
        '/work/repo': { toplevel: '/work/repo', remotes: ['origin\tgit@github.com:acme/widgets.git (fetch)'] },
        '/work/repo/sub': { toplevel: '/work/repo', remotes: ['origin\tgit@github.com:acme/widgets.git (fetch)'] },
      }),
    );

    const repos = await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    expect(repos).toHaveLength(1);
  });

  it('propagates a find failure as an error instead of an empty result', async () => {
    const { factory } = makeTransportFactory(async () => ({ stdout: '', stderr: 'find: /work: Permission denied', code: 1 }));
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/scan failed/i);
  });

  it('propagates a transport-level rejection from the find step', async () => {
    const { factory } = makeTransportFactory(async () => { throw new Error('ssh connection lost'); });
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/ssh connection lost/);
  });

  it('propagates a nonzero `git --version` precheck as an error instead of an empty result (Issue #19 review round 2/3, Important finding 1)', async () => {
    const { factory, gitSpecs } = makeTransportFactory(
      async () => findAnswer('/work/repo/.git\n'),
      () => failed(127, 'git: command not found'),
    );
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/remote lookup failed.*exit code 127/i);
    expect(gitSpecs).toHaveLength(1);
  });

  it('reports a git that cannot be started as the same unusable-git failure', async () => {
    const { factory } = makeTransportFactory(
      async () => findAnswer('/work/repo/.git\n'),
      () => { throw new CommandSpawnError('ENOENT', 'spawn git ENOENT'); },
    );
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/'git' is not usable.*spawn git ENOENT/);
  });

  it('propagates a failure to run a candidate\'s git (timeout, transport) instead of dropping the candidate', async () => {
    const { factory } = makeTransportFactory(
      async () => findAnswer('/work/repo/.git\n'),
      (spec) => {
        if (spec.args[0] === '--version') return ok('git version 2.43.0');
        throw new CommandTimeoutError(15_000, '', '');
      },
    );
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  describe('a broken candidate does not depend on its position (Issue #19 review round 3, Important finding 1)', () => {
    // A single broken/unreadable candidate (rev-parse exits non-zero) is dropped while every other candidate is still
    // returned, wherever it falls in `find`'s filesystem-dependent order.
    function makeBrokenFactory(brokenPosition: 'first' | 'last') {
      const paths = brokenPosition === 'first'
        ? '/work/broken-repo/.git\n/work/good-repo/.git\n'
        : '/work/good-repo/.git\n/work/broken-repo/.git\n';
      return makeTransportFactory(
        async () => findAnswer(paths),
        gitFor({
          '/work/good-repo': { toplevel: '/work/good-repo', remotes: ['origin\thttps://github.com/acme/widgets.git (fetch)'] },
          '/work/broken-repo': {},
        }),
      ).factory;
    }

    it('drops only the broken candidate when it is FIRST', async () => {
      const repos = await new RepoDiscoveryService(makeBrokenFactory('first')).discover(makeServer(), '/work');
      expect(repos.map((r) => r.absolutePath)).toEqual(['/work/good-repo']);
    });

    it('drops only the broken candidate when it is LAST', async () => {
      const repos = await new RepoDiscoveryService(makeBrokenFactory('last')).discover(makeServer(), '/work');
      expect(repos.map((r) => r.absolutePath)).toEqual(['/work/good-repo']);
    });
  });

  it('keeps a repository whose remote listing fails, with no remotes', async () => {
    const { factory } = makeTransportFactory(
      async () => findAnswer('/work/repo/.git\n'),
      gitFor({ '/work/repo': { toplevel: '/work/repo', remoteFails: true } }),
    );
    const repos = await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    expect(repos).toEqual([{ relativePath: 'repo', absolutePath: '/work/repo', remotes: [] }]);
  });

  it('keeps the order of find\'s output and inspects only a bounded number of candidates at once', async () => {
    const dirs = Array.from({ length: 20 }, (_, i) => `/work/r${String(i).padStart(2, '0')}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const { factory } = makeTransportFactory(
      async () => findAnswer(dirs.map((d) => `${d}/.git`).join('\n') + '\n'),
      async (spec) => {
        if (spec.args[0] === '--version') return ok('git version 2.43.0');
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return spec.args[2] === 'rev-parse' ? ok(`${spec.args[1]}\n`) : ok('');
      },
    );
    const repos = await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    expect(repos.map((r) => r.absolutePath)).toEqual(dirs);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('returns an empty list when no .git entries are found', async () => {
    const { factory, gitSpecs } = makeTransportFactory(async () => findAnswer(''));
    expect(await new RepoDiscoveryService(factory).discover(makeServer(), '/work')).toEqual([]);
    expect(gitSpecs).toHaveLength(0);
  });

  // Each migrated call is pinned to what the old shell batch ran: the argv a real sh makes of the old `git ...` part equals the new args.
  it.skipIf(process.platform === 'win32')('runs the same argv as the old shell strings', async () => {
    const dir = "/work/it's here";
    const { factory, gitSpecs } = makeTransportFactory(
      async () => findAnswer(`${dir}/.git\n`),
      gitFor({ [dir]: { toplevel: dir } }),
    );
    await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    const quoted = "'/work/it'\\''s here'";
    expect(gitSpecs.map(argvOfSpec)).toEqual([
      'git --version',
      `git -C ${quoted} rev-parse --show-toplevel`,
      `git -C ${quoted} remote -v`,
    ].map(argvOfShellLine));
  });

  it('is never given a shell batch: no exec call carries git', async () => {
    const execCalls: string[] = [];
    const { factory } = makeTransportFactory(
      async (cmd) => { execCalls.push(cmd); return findAnswer('/work/repo/.git\n'); },
      gitFor({ '/work/repo': { toplevel: '/work/repo' } }),
    );
    await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].startsWith('find')).toBe(true);
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
    // Windows では動かない: /bin/bash で find を実行する前提
    it.skipIf(process.platform === 'win32')('finds both a normal repo and a worktree .git under a hidden directory', async () => {
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
      const tf = {
        getTransport: () => ({
          exec: vi.fn(async (cmd: string) => {
            capturedFindCmd = cmd;
            const stdout = execSync(cmd, { shell: '/bin/bash' }).toString();
            return { stdout, stderr: '', code: 0 };
          }),
          // The candidates are not inspected here (only the find command is under test): every git command exits 1.
          run: vi.fn(async (spec: CommandSpec) => (spec.args[0] === '--version' ? ok('git version 2.43.0') : failed(128))),
        }),
      } as unknown as TransportFactory;

      const service = new RepoDiscoveryService(tf);
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
      const service = new RepoDiscoveryService(makeTransportFactory(async () => ({ stdout: '', stderr: '', code: 0 })).factory);

      const status = await service.checkPathStatus(makeServer(), '/does/not/exist');

      expect(status).toEqual({ exists: false, isGitRepository: false });
    });

    it('reports exists:true, isGitRepository:false for an existing non-git directory', async () => {
      const service = new RepoDiscoveryService(makeTransportFactory(async () => ({ stdout: 'EXISTS\n', stderr: '', code: 0 })).factory);

      const status = await service.checkPathStatus(makeServer(), '/work/plain-dir');

      expect(status).toEqual({ exists: true, isGitRepository: false });
    });

    it('reports exists:true, isGitRepository:true when the path itself has a .git entry', async () => {
      const service = new RepoDiscoveryService(makeTransportFactory(async () => ({ stdout: 'EXISTS\nISGIT\n', stderr: '', code: 0 })).factory);

      const status = await service.checkPathStatus(makeServer(), '/work/repo');

      expect(status).toEqual({ exists: true, isGitRepository: true });
    });

    it('throws (does not silently report exists:false) on a transport-level failure', async () => {
      const service = new RepoDiscoveryService(makeTransportFactory(async () => ({ stdout: '', stderr: 'boom', code: 1 })).factory);

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
