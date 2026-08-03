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
    const execFn = vi.fn(async () => ok(''));
    const transport = { exec: execFn } as unknown as IServerTransport;
    const factory = { getTransport: () => transport } as unknown as TransportFactory;
    const svc = new GitDiffService(factory);

    await svc.getCommits(srv, '/repo');
    expect((execFn.mock.calls as string[][])[0][0]).toContain('-50 HEAD');
  });

  it('uses base..HEAD when base is provided', async () => {
    const execFn = vi.fn(async () => ok(''));
    const transport = { exec: execFn } as unknown as IServerTransport;
    const factory = { getTransport: () => transport } as unknown as TransportFactory;
    const svc = new GitDiffService(factory);

    await svc.getCommits(srv, '/repo', 'main');
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
    const execFn = vi.fn(async () => ok(''));
    const transport = { exec: execFn } as unknown as IServerTransport;
    const factory = { getTransport: () => transport } as unknown as TransportFactory;
    const svc = new GitDiffService(factory);

    await svc.getDiff(srv, '/repo', '', 'abc1234');
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
    const execFn = vi.fn(async () => ok(''));
    const transport = { exec: execFn } as unknown as IServerTransport;
    const factory = { getTransport: () => transport } as unknown as TransportFactory;
    const svc = new GitDiffService(factory);

    await svc.getDiff(srv, '/repo', '', 'abc1234');
    const calls = (execFn.mock.calls as string[][]).map((c) => c[0]);
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(false);
  });
});
