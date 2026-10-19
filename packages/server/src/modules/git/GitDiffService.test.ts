import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalFileOps, localFileOpsHostFromEnv } from '../../shared/fs/LocalFileOps';
import { GitDiffService, SAFE_HASH } from './GitDiffService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import type { CommandResult, CommandSpec } from '../../shared/exec/commandSpec';
import { argvOfShellLine, argvOfSpec, failed, ok, specText } from '../../shared/exec/testing/commandTesting';

type GitResponder = (spec: CommandSpec, index: number) => CommandResult;

/** git goes through `run`; an untracked file is read through the host's file operations (here the real ones, on this machine). */
function makeService(onGit: GitResponder = () => ok()) {
  const gitCalls: CommandSpec[] = [];
  const files = new LocalFileOps(localFileOpsHostFromEnv({ platform: process.platform, homeDir: tmpdir(), tmpDir: tmpdir() }, process.env));
  const transport = {
    run: async (spec: CommandSpec) => onGit(spec, gitCalls.push(spec)),
    files: () => files,
  } as unknown as IServerTransport;
  const factory = { getTransport: () => transport } as unknown as TransportFactory;
  return { service: new GitDiffService(factory), gitCalls, gitTexts: () => gitCalls.map(specText) };
}

const srv = { name: 'test', type: 'local' } as ServerConfig;

describe('SAFE_HASH', () => {
  it('accepts valid short and full hashes', () => {
    expect(SAFE_HASH.test('abc1234')).toBe(true);
    expect(SAFE_HASH.test('abc1234567890abc1234567890abc123456789ab')).toBe(true);
  });

  it('rejects uppercase, too short, or special chars', () => {
    expect(SAFE_HASH.test('ABC123')).toBe(false);
    expect(SAFE_HASH.test('abc12')).toBe(false);
    expect(SAFE_HASH.test('abc1234; rm -rf /')).toBe(false);
    expect(SAFE_HASH.test('')).toBe(false);
  });
});

describe('GitDiffService.getCommits', () => {
  it('parses commit log output with record separator', async () => {
    const F = '<<>>';
    const R = '<<||>>';
    const stdout =
      `aaa1111222233334444555566667777888899990000${F}aaa1111${F}Alice${F}2026-01-15T10:00:00+09:00${F}First commit${R}` +
      `bbb2222333344445555666677778888999900001111${F}bbb2222${F}Bob${F}2026-01-16T11:00:00+09:00${F}Second commit${R}`;

    const { service } = makeService(() => ok(stdout));
    const commits = await service.getCommits(srv, '/path/to/repo', 'main');

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'aaa1111222233334444555566667777888899990000',
      shortHash: 'aaa1111',
      author: 'Alice',
      date: '2026-01-15T10:00:00+09:00',
      subject: 'First commit',
    });
    expect(commits[1].shortHash).toBe('bbb2222');
  });

  it('returns empty array when no commits', async () => {
    expect(await makeService(() => ok('')).service.getCommits(srv, '/path/to/repo', 'main')).toEqual([]);
  });

  it('uses -50 HEAD when base is omitted', async () => {
    const { service, gitCalls } = makeService();
    await service.getCommits(srv, '/repo');
    expect(gitCalls[0].args.slice(-2)).toEqual(['-50', 'HEAD']);
  });

  it('uses base..HEAD when base is provided', async () => {
    const { service, gitCalls } = makeService();
    await service.getCommits(srv, '/repo', 'main');
    expect(gitCalls[0].args.at(-1)).toBe('main..HEAD');
  });

  it('passes the directory as a whole argument, whatever it contains', async () => {
    const { service, gitCalls } = makeService();
    await service.getCommits(srv, "/repo/it's here; echo pwned");
    expect(gitCalls[0].args.slice(0, 4)).toEqual(['-c', 'core.quotepath=false', '-C', "/repo/it's here; echo pwned"]);
  });

  it('throws with git\'s message when git exits non-zero', async () => {
    const { service } = makeService(() => failed(128, 'fatal: not a git repository'));
    await expect(service.getCommits(srv, '/bad/path')).rejects.toThrow('git log failed: fatal: not a git repository');
  });

  it('throws with the exit code when git said nothing', async () => {
    const { service } = makeService(() => failed(1));
    await expect(service.getCommits(srv, '/bad/path')).rejects.toThrow('git log failed: exit 1');
  });

  it('throws on invalid base branch', async () => {
    await expect(makeService().service.getCommits(srv, '/repo', 'bad branch!')).rejects.toThrow('Invalid base branch');
  });

  it('refuses a base git would read as an option', async () => {
    const { service, gitCalls } = makeService();
    await expect(service.getCommits(srv, '/repo', '--all')).rejects.toThrow(/Unsafe base branch/);
    expect(gitCalls).toHaveLength(0);
  });
});

describe('GitDiffService.getDiff with commit', () => {
  it('uses git show for single commit diff', async () => {
    const { service, gitCalls } = makeService();
    await service.getDiff(srv, '/repo', '', 'abc1234');
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0].args).toEqual(['-c', 'core.quotepath=false', '-C', '/repo', 'show', '--format=', '--unified=3', 'abc1234']);
  });

  it('returns commit short hash as headBranch', async () => {
    const diffOutput = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;
    const { service } = makeService(() => ok(diffOutput));
    const result = await service.getDiff(srv, '/repo', '', 'abc1234def5678');
    expect(result.headBranch).toBe('abc1234');
    expect(result.baseBranch).toBe('abc1234def5678^');
  });

  it('throws on invalid commit hash', async () => {
    await expect(makeService().service.getDiff(srv, '/repo', '', 'not-a-hash!')).rejects.toThrow('Invalid commit hash');
  });

  it('skips rev-parse when commit is specified', async () => {
    const { service, gitTexts } = makeService();
    await service.getDiff(srv, '/repo', '', 'abc1234');
    expect(gitTexts().some((c) => c.includes('rev-parse'))).toBe(false);
  });

  it('throws when git show fails', async () => {
    const { service } = makeService(() => failed(128, 'fatal: bad object abc1234'));
    await expect(service.getDiff(srv, '/repo', '', 'abc1234')).rejects.toThrow('git diff failed: fatal: bad object abc1234');
  });
});

describe('GitDiffService.getDiff with scope=uncommitted', () => {
  /** The five parallel git commands in order: staged names, unstaged names, diff HEAD, status, rev-parse. */
  function uncommittedAnswers(answers: string[]): GitResponder {
    return (_spec, index) => ok(answers[index - 1] ?? '');
  }

  it('assigns staged group to files in cached diff only', async () => {
    const diffOutput = `diff --git a/staged.ts b/staged.ts
--- a/staged.ts
+++ b/staged.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;
    const { service } = makeService(uncommittedAnswers(['staged.ts\n', '', diffOutput, '', 'feature-branch']));
    const result = await service.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].group).toBe('staged');
    expect(result.files[0].file).toBe('staged.ts');
    expect(result.headBranch).toBe('feature-branch');
  });

  it('assigns unstaged group when file is in both staged and unstaged', async () => {
    const diffOutput = `diff --git a/both.ts b/both.ts
--- a/both.ts
+++ b/both.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;
    const { service } = makeService(uncommittedAnswers(['both.ts\n', 'both.ts\n', diffOutput, '', 'main']));
    const result = await service.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    expect(result.files[0].group).toBe('unstaged');
  });

  it('names HEAD when rev-parse fails (no commits yet)', async () => {
    const { service } = makeService((spec, index) => (spec.args.includes('rev-parse') ? failed(128, 'fatal: ambiguous argument HEAD') : uncommittedAnswers([])(spec, index)));
    const result = await service.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    expect(result.headBranch).toBe('HEAD');
  });

  describe('untracked files', () => {
    let repo: string;
    beforeEach(() => {
      repo = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-gitdiff-')));
    });
    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    const untrackedOf = async (porcelain: string) => {
      const { service } = makeService(uncommittedAnswers(['', '', '', porcelain, 'main']));
      return service.getDiff(srv, repo, '', undefined, { scope: 'uncommitted' });
    };

    it('synthesizes untracked file diffs', async () => {
      writeFileSync(path.join(repo, 'newfile.ts'), 'const x = 1;\nexport default x;\n');
      const result = await untrackedOf('?? newfile.ts\n');
      const untracked = result.files.filter((f) => f.group === 'untracked');
      expect(untracked).toHaveLength(1);
      expect(untracked[0].file).toBe('newfile.ts');
      expect(untracked[0].status).toBe('A');
      expect(untracked[0].additions).toBe(2);
      expect(untracked[0].isBinary).toBe(false);
      expect(untracked[0].hunks[0].lines.map((l) => l.content)).toEqual(['const x = 1;', 'export default x;']);
    });

    it('marks binary untracked files (a NUL byte in the first 8KB)', async () => {
      writeFileSync(path.join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0, 0x47]));
      const untracked = (await untrackedOf('?? image.png\n')).files.filter((f) => f.group === 'untracked');
      expect(untracked).toHaveLength(1);
      expect(untracked[0].isBinary).toBe(true);
    });

    it('lists a file over the size limit without its content', async () => {
      writeFileSync(path.join(repo, 'big.log'), 'x\n'.repeat(60_000));
      const untracked = (await untrackedOf('?? big.log\n')).files.filter((f) => f.group === 'untracked');
      expect(untracked).toEqual([expect.objectContaining({ file: 'big.log', additions: 0, hunks: [], isBinary: false })]);
    });

    it('reads a file in a subdirectory and with a name hostile to a shell', async () => {
      const odd = "sub dir/it's $(id).txt";
      mkdirSync(path.join(repo, 'sub dir'));
      writeFileSync(path.join(repo, odd), 'one\n');
      const untracked = (await untrackedOf(`?? "${odd}"\n`)).files.filter((f) => f.group === 'untracked');
      expect(untracked.map((f) => f.additions)).toEqual([1]);
    });

    it('leaves out a path that is gone since git status, and says the result is truncated', async () => {
      const result = await untrackedOf('?? vanished.ts\n');
      expect(result.files.filter((f) => f.group === 'untracked')).toEqual([]);
      expect(result.truncated).toBe(true);
    });

    it('truncates when too many untracked files', async () => {
      const untrackedLines = Array.from({ length: 60 }, (_, i) => `?? file${i}.ts`).join('\n') + '\n';
      for (let i = 0; i < 60; i++) writeFileSync(path.join(repo, `file${i}.ts`), 'x\n');
      const result = await untrackedOf(untrackedLines);
      expect(result.truncated).toBe(true);
      expect(result.files.filter((f) => f.group === 'untracked')).toHaveLength(50);
    });
  });

  it('throws when the diff against HEAD fails', async () => {
    const { service } = makeService((spec, index) => (spec.args.includes('--unified=3') ? failed(128, 'fatal: bad revision') : uncommittedAnswers([])(spec, index)));
    await expect(service.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' })).rejects.toThrow('git diff failed: fatal: bad revision');
  });
});

describe('GitDiffService.getDiff with scope=base', () => {
  it('uses merge-base when includeUncommitted=true', async () => {
    const { service, gitCalls } = makeService((spec) => {
      if (spec.args.includes('rev-parse')) return ok('feature');
      if (spec.args.includes('merge-base')) return ok('abc1234567890\n');
      return ok('');
    });

    await service.getDiff(srv, '/repo', 'main', undefined, { scope: 'base', includeUncommitted: true });
    expect(gitCalls.map((c) => c.args)).toEqual([
      ['-C', '/repo', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['-C', '/repo', 'merge-base', 'main', 'HEAD'],
      ['-c', 'core.quotepath=false', '-C', '/repo', 'diff', '--unified=3', 'abc1234567890'],
    ]);
  });

  it('throws when merge-base fails', async () => {
    const { service } = makeService((spec) => (spec.args.includes('merge-base') ? failed(1) : ok('feature')));
    await expect(service.getDiff(srv, '/repo', 'main', undefined, { scope: 'base', includeUncommitted: true })).rejects.toThrow('git merge-base failed: exit 1');
  });

  it('uses three-dot when includeUncommitted=false', async () => {
    const { service, gitTexts } = makeService((spec) => (spec.args.includes('rev-parse') ? ok('feature') : ok('')));

    await service.getDiff(srv, '/repo', 'main', undefined, { scope: 'base', includeUncommitted: false });
    expect(gitTexts().some((c) => c.endsWith('main...HEAD'))).toBe(true);
    expect(gitTexts().some((c) => c.includes('merge-base'))).toBe(false);
  });

  it('throws when base is missing for base scope', async () => {
    await expect(makeService().service.getDiff(srv, '/repo', '', undefined, { scope: 'base' })).rejects.toThrow('base branch is required');
  });

  it('refuses a base git would read as an option', async () => {
    const { service, gitCalls } = makeService();
    await expect(service.getDiff(srv, '/repo', '--output=/tmp/x', undefined, { scope: 'base' })).rejects.toThrow();
    await expect(service.getDiff(srv, '/repo', '--cached', undefined, { scope: 'base' })).rejects.toThrow(/Unsafe base branch/);
    expect(gitCalls).toHaveLength(0);
  });
});

describe('GitDiffService.getDiff backward compatibility', () => {
  it('uses legacy diff when no scope is specified', async () => {
    const { service, gitTexts } = makeService((spec) => (spec.args.includes('rev-parse') ? ok('feature') : ok('')));
    const result = await service.getDiff(srv, '/repo', 'main');
    expect(gitTexts().some((c) => c.endsWith('main...HEAD'))).toBe(true);
    expect(result.headBranch).toBe('feature');
  });

  it('diffs against HEAD when there is no base', async () => {
    const { service, gitCalls } = makeService();
    await service.getDiff(srv, '/repo', '');
    expect(gitCalls.at(-1)!.args.at(-1)).toBe('HEAD');
  });
});

// Each migrated call is pinned to what the old shell string became: the argv a real sh makes of the old `git ...` part equals the new args.
describe.skipIf(process.platform === 'win32')('GitDiffService: argv is the same as the old shell strings', () => {
  const dir = "/path/it's here";
  const quoted = "'/path/it'\\''s here'";

  it('matches the commands of every scope', async () => {
    const { service, gitCalls } = makeService((spec) => (spec.args.includes('merge-base') ? ok('abc1234\n') : ok('x')));
    await service.getCommits(srv, dir, 'main');
    await service.getCommits(srv, dir);
    await service.getDiff(srv, dir, '', 'abc1234');
    await service.getDiff(srv, dir, 'main');
    await service.getDiff(srv, dir, '', undefined, { scope: 'uncommitted' });
    await service.getDiff(srv, dir, 'main', undefined, { scope: 'base', includeUncommitted: true });
    await service.getDiff(srv, dir, 'main', undefined, { scope: 'base', includeUncommitted: false });

    const fmt = '%H<<>>%h<<>>%an<<>>%aI<<>>%s<<||>>';
    const expected = [
      `git -c core.quotepath=false -C ${quoted} log --pretty=format:'${fmt}' main..HEAD`,
      `git -c core.quotepath=false -C ${quoted} log --pretty=format:'${fmt}' -50 HEAD`,
      `git -c core.quotepath=false -C ${quoted} show --format= --unified=3 abc1234`,
      `git -C ${quoted} rev-parse --abbrev-ref HEAD`,
      `git -c core.quotepath=false -C ${quoted} diff --unified=3 main...HEAD`,
      `git -c core.quotepath=false -C ${quoted} diff --cached --name-only`,
      `git -c core.quotepath=false -C ${quoted} diff --name-only`,
      `git -c core.quotepath=false -C ${quoted} diff --unified=3 HEAD`,
      `git -c core.quotepath=false -C ${quoted} status --porcelain -uall`,
      `git -C ${quoted} rev-parse --abbrev-ref HEAD`,
      `git -C ${quoted} rev-parse --abbrev-ref HEAD`,
      `git -C ${quoted} merge-base 'main' HEAD`,
      `git -c core.quotepath=false -C ${quoted} diff --unified=3 abc1234`,
      `git -C ${quoted} rev-parse --abbrev-ref HEAD`,
      `git -c core.quotepath=false -C ${quoted} diff --unified=3 main...HEAD`,
    ];
    expect(gitCalls.map(argvOfSpec)).toEqual(expected.map(argvOfShellLine));
  });
});
