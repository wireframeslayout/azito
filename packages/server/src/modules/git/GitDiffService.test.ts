import { describe, it, expect, vi } from 'vitest';
import { GitDiffService, SAFE_HASH } from './GitDiffService';
import type { IServerTransport, ExecResult } from '../servers/transport/ServerTransport';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

function makeService(execFn: (...args: unknown[]) => Promise<ExecResult>): GitDiffService {
  const transport = { exec: vi.fn(execFn) } as unknown as IServerTransport;
  const factory = { getTransport: () => transport } as unknown as TransportFactory;
  return new GitDiffService(factory);
}

function makeServiceWithTransport(execFn: (...args: unknown[]) => Promise<ExecResult>) {
  const transport = { exec: vi.fn(execFn) } as unknown as IServerTransport;
  const factory = { getTransport: () => transport } as unknown as TransportFactory;
  return { service: new GitDiffService(factory), execFn: transport.exec as ReturnType<typeof vi.fn> };
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

    const svc = makeService(async () => ok(stdout));
    const commits = await svc.getCommits(srv, '/path/to/repo', 'main');

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
    const svc = makeService(async () => ok(''));
    const commits = await svc.getCommits(srv, '/path/to/repo', 'main');
    expect(commits).toEqual([]);
  });

  it('uses -50 HEAD when base is omitted', async () => {
    const { service, execFn } = makeServiceWithTransport(async () => ok(''));
    await service.getCommits(srv, '/repo');
    expect((execFn.mock.calls as string[][])[0][0]).toContain('-50 HEAD');
  });

  it('uses base..HEAD when base is provided', async () => {
    const { service, execFn } = makeServiceWithTransport(async () => ok(''));
    await service.getCommits(srv, '/repo', 'main');
    expect((execFn.mock.calls as string[][])[0][0]).toContain('main..HEAD');
  });

  it('throws on fatal git output', async () => {
    const svc = makeService(async () => ok('fatal: not a git repository'));
    await expect(svc.getCommits(srv, '/bad/path')).rejects.toThrow('git log failed');
  });

  it('throws on invalid base branch', async () => {
    const svc = makeService(async () => ok(''));
    await expect(svc.getCommits(srv, '/repo', 'bad branch!')).rejects.toThrow('Invalid base branch');
  });
});

describe('GitDiffService.getDiff with commit', () => {
  it('uses git show for single commit diff', async () => {
    const { service, execFn } = makeServiceWithTransport(async () => ok(''));
    await service.getDiff(srv, '/repo', '', 'abc1234');
    expect((execFn.mock.calls as string[][])[0][0]).toContain('show --format= --unified=3 abc1234');
    expect(execFn).toHaveBeenCalledTimes(1);
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
    const svc = makeService(async () => ok(diffOutput));
    const result = await svc.getDiff(srv, '/repo', '', 'abc1234def5678');
    expect(result.headBranch).toBe('abc1234');
    expect(result.baseBranch).toBe('abc1234def5678^');
  });

  it('throws on invalid commit hash', async () => {
    const svc = makeService(async () => ok(''));
    await expect(svc.getDiff(srv, '/repo', '', 'not-a-hash!')).rejects.toThrow('Invalid commit hash');
  });

  it('skips rev-parse when commit is specified', async () => {
    const { service, execFn } = makeServiceWithTransport(async () => ok(''));
    await service.getDiff(srv, '/repo', '', 'abc1234');
    const calls = (execFn.mock.calls as string[][]).map((c) => c[0]);
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(false);
  });
});

describe('GitDiffService.getDiff with scope=uncommitted', () => {
  it('assigns staged group to files in cached diff only', async () => {
    const diffOutput = `diff --git a/staged.ts b/staged.ts
--- a/staged.ts
+++ b/staged.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;
    let callIndex = 0;
    const svc = makeService(async () => {
      callIndex++;
      // 1: cached name-only (staged)
      if (callIndex === 1) return ok('staged.ts\n');
      // 2: name-only (unstaged)
      if (callIndex === 2) return ok('');
      // 3: diff HEAD
      if (callIndex === 3) return ok(diffOutput);
      // 4: status --porcelain
      if (callIndex === 4) return ok('');
      // 5: rev-parse HEAD
      return ok('feature-branch');
    });

    const result = await svc.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].group).toBe('staged');
    expect(result.files[0].file).toBe('staged.ts');
  });

  it('assigns unstaged group when file is in both staged and unstaged', async () => {
    const diffOutput = `diff --git a/both.ts b/both.ts
--- a/both.ts
+++ b/both.ts
@@ -1,1 +1,2 @@
 line1
+line2
`;
    let callIndex = 0;
    const svc = makeService(async () => {
      callIndex++;
      if (callIndex === 1) return ok('both.ts\n');
      if (callIndex === 2) return ok('both.ts\n');
      if (callIndex === 3) return ok(diffOutput);
      if (callIndex === 4) return ok('');
      return ok('main');
    });

    const result = await svc.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    expect(result.files[0].group).toBe('unstaged');
  });

  it('synthesizes untracked file diffs', async () => {
    let callIndex = 0;
    const svc = makeService(async () => {
      callIndex++;
      if (callIndex <= 2) return ok('');
      if (callIndex === 3) return ok('');
      if (callIndex === 4) return ok('?? newfile.ts\n');
      if (callIndex === 5) return ok('main');
      // wc -c for file size
      if (callIndex === 6) return ok('25');
      // head -c for binary check
      if (callIndex === 7) return ok('0');
      // cat for content
      if (callIndex === 8) return ok('const x = 1;\nexport default x;\n');
      return ok('');
    });

    const result = await svc.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    const untracked = result.files.filter((f) => f.group === 'untracked');
    expect(untracked).toHaveLength(1);
    expect(untracked[0].file).toBe('newfile.ts');
    expect(untracked[0].status).toBe('A');
    expect(untracked[0].additions).toBe(2);
    expect(untracked[0].isBinary).toBe(false);
  });

  it('marks binary untracked files', async () => {
    let callIndex = 0;
    const svc = makeService(async () => {
      callIndex++;
      if (callIndex <= 3) return ok('');
      if (callIndex === 4) return ok('?? image.png\n');
      if (callIndex === 5) return ok('main');
      if (callIndex === 6) return ok('5000');
      if (callIndex === 7) return ok('3');
      return ok('');
    });

    const result = await svc.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    const untracked = result.files.filter((f) => f.group === 'untracked');
    expect(untracked).toHaveLength(1);
    expect(untracked[0].isBinary).toBe(true);
  });

  it('truncates when too many untracked files', async () => {
    const untrackedLines = Array.from({ length: 60 }, (_, i) => `?? file${i}.ts`).join('\n') + '\n';
    let callIndex = 0;
    const svc = makeService(async () => {
      callIndex++;
      if (callIndex <= 3) return ok('');
      if (callIndex === 4) return ok(untrackedLines);
      if (callIndex === 5) return ok('main');
      // For each of the 50 processed files: wc -c, head, cat
      return ok('10');
    });

    const result = await svc.getDiff(srv, '/repo', '', undefined, { scope: 'uncommitted' });
    expect(result.truncated).toBe(true);
  });
});

describe('GitDiffService.getDiff with scope=base', () => {
  it('uses merge-base when includeUncommitted=true', async () => {
    const { service, execFn } = makeServiceWithTransport(async (...args: unknown[]) => { const cmd = args[0] as string;
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return ok('feature');
      if (typeof cmd === 'string' && cmd.includes('merge-base')) return ok('abc1234567890');
      return ok('');
    });

    await service.getDiff(srv, '/repo', 'main', undefined, { scope: 'base', includeUncommitted: true });
    const calls = (execFn.mock.calls as string[][]).map((c) => c[0]);
    expect(calls.some((c) => c.includes('merge-base'))).toBe(true);
    expect(calls.some((c) => c.includes('abc1234567890'))).toBe(true);
  });

  it('uses three-dot when includeUncommitted=false', async () => {
    const { service, execFn } = makeServiceWithTransport(async (...args: unknown[]) => { const cmd = args[0] as string;
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return ok('feature');
      return ok('');
    });

    await service.getDiff(srv, '/repo', 'main', undefined, { scope: 'base', includeUncommitted: false });
    const calls = (execFn.mock.calls as string[][]).map((c) => c[0]);
    expect(calls.some((c) => c.includes('main...HEAD'))).toBe(true);
    expect(calls.some((c) => c.includes('merge-base'))).toBe(false);
  });

  it('throws when base is missing for base scope', async () => {
    const svc = makeService(async () => ok(''));
    await expect(svc.getDiff(srv, '/repo', '', undefined, { scope: 'base' })).rejects.toThrow('base branch is required');
  });
});

describe('GitDiffService.getDiff backward compatibility', () => {
  it('uses legacy diff when no scope is specified', async () => {
    const { service, execFn } = makeServiceWithTransport(async (...args: unknown[]) => { const cmd = args[0] as string;
      if (typeof cmd === 'string' && cmd.includes('rev-parse')) return ok('feature');
      return ok('');
    });

    await service.getDiff(srv, '/repo', 'main');
    const calls = (execFn.mock.calls as string[][]).map((c) => c[0]);
    expect(calls.some((c) => c.includes('main...HEAD'))).toBe(true);
  });
});
