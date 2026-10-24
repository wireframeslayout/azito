import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoDiscoveryService, toDiscoveryResponse } from './RepoDiscoveryService';
import { normalizeRemoteUrl } from './parseRemoteUrl';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import { CommandSpawnError, CommandTimeoutError, type CommandResult, type CommandSpec } from '../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, ok } from '../../shared/exec/testing/commandTesting';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';

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

/**
 * A host's file tree for the scan: `paths` ending in "/" are directories, the others regular files (every ancestor directory
 * exists). `listFails` makes listing fail the way the host says (a FileOpsError, or any other error for a transport failure).
 */
function treeOps(paths: string[], listFails?: Error): IFileOps {
  const children = new Map<string, Map<string, 'file' | 'directory'>>();
  const add = (dir: string, name: string, kind: 'file' | 'directory'): void => {
    if (!children.has(dir)) children.set(dir, new Map());
    children.get(dir)!.set(name, kind);
  };
  for (const entry of paths) {
    const parts = entry.split('/').filter(Boolean);
    parts.forEach((name, i) => {
      const dir = '/' + parts.slice(0, i).join('/');
      const isLast = i === parts.length - 1;
      const kind = isLast && !entry.endsWith('/') ? 'file' : 'directory';
      add(dir, name, kind);
      if (kind === 'directory' && !children.has('/' + parts.slice(0, i + 1).join('/'))) children.set('/' + parts.slice(0, i + 1).join('/'), new Map());
    });
  }
  return {
    platform: 'linux',
    list: async (dir: string) => {
      if (listFails) throw listFails;
      const entries = children.get(dir.length > 1 ? dir.replace(/\/$/, '') : dir);
      if (!entries) throw new FileOpsError('NOT_FOUND', `ENOENT: no such file or directory, scandir '${dir}'`);
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
    stat: async (p: string) => {
      const parts = p.split('/').filter(Boolean);
      const parent = '/' + parts.slice(0, -1).join('/');
      const kind = children.get(parent)?.get(parts[parts.length - 1]);
      return kind ? { kind, size: 0, mtimeMs: 0, mode: 0o644 } : null;
    },
  } as unknown as IFileOps;
}

/** The file scan goes through the host's file operations; every git command goes through `run`. Calls are recorded in order. */
function makeTransportFactory(
  files: IFileOps,
  git: (spec: CommandSpec) => CommandResult | Promise<CommandResult> = () => ok(),
) {
  const gitSpecs: CommandSpec[] = [];
  const transport = {
    files: () => files,
    run: vi.fn(async (spec: CommandSpec) => { gitSpecs.push(spec); return git(spec); }),
  };
  return { factory: { getTransport: () => transport } as unknown as TransportFactory, gitSpecs };
}

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
      // A worktree's .git is a regular file.
      treeOps([`${wt}/.git`]),
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

  it('reports the scanned directory itself as "." (with or without a trailing slash)', async () => {
    for (const root of ['/work/repo', '/work/repo/']) {
      const { factory } = makeTransportFactory(treeOps(['/work/repo/.git/']), gitFor({ '/work/repo': { toplevel: '/work/repo' }, '/work/repo/': { toplevel: '/work/repo' } }));
      const repos = await new RepoDiscoveryService(factory).discover(makeServer(), root);
      expect(repos.map((r) => [r.absolutePath, r.relativePath])).toEqual([['/work/repo', '.']]);
    }
  });

  it('dedupes when multiple candidates resolve to the same toplevel', async () => {
    const { factory } = makeTransportFactory(
      treeOps(['/work/repo/.git/', '/work/repo/sub/.git/']),
      gitFor({
        '/work/repo': { toplevel: '/work/repo', remotes: ['origin\tgit@github.com:acme/widgets.git (fetch)'] },
        '/work/repo/sub': { toplevel: '/work/repo', remotes: ['origin\tgit@github.com:acme/widgets.git (fetch)'] },
      }),
    );

    const repos = await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    expect(repos).toHaveLength(1);
  });

  it('propagates a listing failure as an error instead of an empty result', async () => {
    const { factory } = makeTransportFactory(treeOps([], new FileOpsError('PERMISSION_DENIED', "EACCES: permission denied, scandir '/work'")));
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/scan failed/i);
  });

  it('propagates a transport-level rejection from the scan', async () => {
    const { factory } = makeTransportFactory(treeOps([], new Error('ssh connection lost')));
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/ssh connection lost/);
  });

  it('propagates a nonzero `git --version` precheck as an error instead of an empty result (Issue #19 review round 2/3, Important finding 1)', async () => {
    const { factory, gitSpecs } = makeTransportFactory(
      treeOps(['/work/repo/.git/']),
      () => failed(127, 'git: command not found'),
    );
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/remote lookup failed.*exit code 127/i);
    expect(gitSpecs).toHaveLength(1);
  });

  it('reports a git that cannot be started as the same unusable-git failure', async () => {
    const { factory } = makeTransportFactory(
      treeOps(['/work/repo/.git/']),
      () => { throw new CommandSpawnError('ENOENT', 'spawn git ENOENT'); },
    );
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toThrow(/'git' is not usable.*spawn git ENOENT/);
  });

  it('propagates a failure to run a candidate\'s git (timeout, transport) instead of dropping the candidate', async () => {
    const { factory } = makeTransportFactory(
      treeOps(['/work/repo/.git/']),
      (spec) => {
        if (spec.args[0] === '--version') return ok('git version 2.43.0');
        throw new CommandTimeoutError(15_000, '', '');
      },
    );
    await expect(new RepoDiscoveryService(factory).discover(makeServer(), '/work')).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  describe('a broken candidate does not depend on its position (Issue #19 review round 3, Important finding 1)', () => {
    // A single broken/unreadable candidate (rev-parse exits non-zero) is dropped while every other candidate is still
    // returned, wherever it falls in the listing's filesystem-dependent order.
    function makeBrokenFactory(brokenPosition: 'first' | 'last') {
      const paths = brokenPosition === 'first'
        ? ['/work/broken-repo/.git/', '/work/good-repo/.git/']
        : ['/work/good-repo/.git/', '/work/broken-repo/.git/'];
      return makeTransportFactory(
        treeOps(paths),
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
      treeOps(['/work/repo/.git/']),
      gitFor({ '/work/repo': { toplevel: '/work/repo', remoteFails: true } }),
    );
    const repos = await new RepoDiscoveryService(factory).discover(makeServer(), '/work');
    expect(repos).toEqual([{ relativePath: 'repo', absolutePath: '/work/repo', remotes: [] }]);
  });

  it('keeps the order of the listing and inspects only a bounded number of candidates at once', async () => {
    const dirs = Array.from({ length: 20 }, (_, i) => `/work/r${String(i).padStart(2, '0')}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const { factory } = makeTransportFactory(
      treeOps(dirs.map((d) => `${d}/.git/`)),
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
    const { factory, gitSpecs } = makeTransportFactory(treeOps(['/work/'], undefined));
    expect(await new RepoDiscoveryService(factory).discover(makeServer(), '/work')).toEqual([]);
    expect(gitSpecs).toHaveLength(0);
  });

  // Each migrated call is pinned to what the old shell batch ran: the argv a real sh makes of the old `git ...` part equals the new args.
  it.skipIf(process.platform === 'win32')('runs the same argv as the old shell strings', async () => {
    const dir = "/work/it's here";
    const { factory, gitSpecs } = makeTransportFactory(
      treeOps([`${dir}/.git/`]),
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

  describe('the scan against a real filesystem fixture (Issue #19 later review round)', () => {
    let fixtureRoot: string;

    afterEach(() => {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    });

    const files = () => new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: tmpdir() }));

    /**
     * Excluding all hidden directories silently excluded AZITO's own task worktrees, which live under a hidden `.worktrees/`
     * directory — a scan that never saw `.worktrees/task-1/.git` (a file, per a real worktree). This runs the real scan against
     * a real temp-directory fixture, so a regression back to the over-broad hidden-directory exclusion is caught even though
     * every other test in this file lists a scripted tree.
     */
    // Windows では動かない: git の toplevel を '/' で始まる絶対パスとしか読まない POSIX 前提（toDiscoveredRepos）。ファイルの走査自体は両 OS で同じ
    it.skipIf(process.platform === 'win32')('finds both a normal repo and a worktree .git under a hidden directory, and skips node_modules and the inside of .git', async () => {
      fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-repo-discovery-')));

      // Normal clone: repo/.git is a directory.
      mkdirSync(join(fixtureRoot, 'repo', '.git'), { recursive: true });

      // AZITO-style task worktree: .worktrees/task-1/.git is a FILE (a `gitdir: ...` pointer), under the hidden `.worktrees/` dir.
      mkdirSync(join(fixtureRoot, '.worktrees', 'task-1'), { recursive: true });
      writeFileSync(join(fixtureRoot, '.worktrees', 'task-1', '.git'), 'gitdir: ../../.git/worktrees/task-1\n');

      // Still excluded: node_modules, and the contents of an already-found .git directory.
      mkdirSync(join(fixtureRoot, 'node_modules', 'somepkg', '.git'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'repo', '.git', 'modules', 'sub', '.git'), { recursive: true });

      const { factory, gitSpecs } = makeTransportFactory(files(), (spec) => {
        if (spec.args[0] === '--version') return ok('git version 2.43.0');
        return spec.args[2] === 'rev-parse' ? ok(`${spec.args[1]}\n`) : ok('');
      });
      const repos = await new RepoDiscoveryService(factory).discover(makeServer(), fixtureRoot);

      expect(repos.map((r) => r.absolutePath).sort()).toEqual([join(fixtureRoot, '.worktrees', 'task-1'), join(fixtureRoot, 'repo')].sort());
      expect(gitSpecs.some((s) => s.args.some((a) => a.includes('node_modules')))).toBe(false);
    });

    // Windows では動かない: 同上（toDiscoveredRepos が '/' 始まりだけを受け付ける）
    it.skipIf(process.platform === 'win32')('does not look deeper than depth + 1 levels', async () => {
      fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-repo-discovery-')));
      mkdirSync(join(fixtureRoot, 'a', 'b', 'c', 'd', '.git'), { recursive: true }); // .git at level 5
      mkdirSync(join(fixtureRoot, 'a', 'b', 'c', '.git'), { recursive: true }); // .git at level 4: within depth 3 + 1
      const { factory } = makeTransportFactory(files(), (spec) => (spec.args[0] === '--version' ? ok('git version 2.43.0') : spec.args[2] === 'rev-parse' ? ok(`${spec.args[1]}\n`) : ok('')));
      const repos = await new RepoDiscoveryService(factory).discover(makeServer(), fixtureRoot, 3);
      expect(repos.map((r) => r.absolutePath)).toEqual([join(fixtureRoot, 'a', 'b', 'c')]);
    });

    it('fails the scan when the working directory does not exist', async () => {
      fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-repo-discovery-')));
      const { factory } = makeTransportFactory(files());
      await expect(new RepoDiscoveryService(factory).discover(makeServer(), join(fixtureRoot, 'missing'))).rejects.toThrow(/scan failed/i);
    });
  });

  describe('checkPathStatus', () => {
    it('reports exists:false without an error for a path that does not exist', async () => {
      const service = new RepoDiscoveryService(makeTransportFactory(treeOps(['/work/'])).factory);

      expect(await service.checkPathStatus(makeServer(), '/does/not/exist')).toEqual({ exists: false, isGitRepository: false });
    });

    it('reports exists:true, isGitRepository:false for an existing non-git directory', async () => {
      const service = new RepoDiscoveryService(makeTransportFactory(treeOps(['/work/plain-dir/'])).factory);

      expect(await service.checkPathStatus(makeServer(), '/work/plain-dir')).toEqual({ exists: true, isGitRepository: false });
    });

    it('reports exists:true, isGitRepository:true when the path itself has a .git entry (a directory or a file)', async () => {
      const service = new RepoDiscoveryService(makeTransportFactory(treeOps(['/work/repo/.git/', '/work/worktree/.git'])).factory);

      expect(await service.checkPathStatus(makeServer(), '/work/repo')).toEqual({ exists: true, isGitRepository: true });
      expect(await service.checkPathStatus(makeServer(), '/work/worktree')).toEqual({ exists: true, isGitRepository: true });
    });

    it('throws (does not silently report exists:false) when the host cannot be asked', async () => {
      const failing = { platform: 'linux', stat: async () => { throw new Error('boom'); } } as unknown as IFileOps;
      const service = new RepoDiscoveryService(makeTransportFactory(failing).factory);

      await expect(service.checkPathStatus(makeServer(), '/work')).rejects.toThrow('boom');
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
