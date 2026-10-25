import { describe, it, expect, vi } from 'vitest';
import { GitInfoCollector } from './GitInfoCollector';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ServerConfig } from '../../servers/Server';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import type { IFileOps } from '../../../shared/fs/fileOps';

const server = { name: 'remote', type: 'agent' } as ServerConfig;

/** git's answer to one invocation: its stdout, or a non-zero exit (git's own refusal). */
type GitAnswer = { stdout: string } | { fail: string } | Error;
type Handler = (args: string[]) => GitAnswer;

function makeCollector(handler: Handler): { collector: GitInfoCollector; calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const transport = {
    run: vi.fn(async (spec: CommandSpec): Promise<CommandResult> => {
      calls.push(spec);
      const answer = handler(spec.args);
      if (answer instanceof Error) throw answer;
      if ('fail' in answer) return { exitCode: 128, signal: null, stdout: '', stderr: answer.fail };
      return { exitCode: 0, signal: null, stdout: answer.stdout, stderr: '' };
    }),
  };
  const transportFactory = { getTransport: () => transport } as unknown as TransportFactory;
  return { collector: new GitInfoCollector(transportFactory), calls };
}

const ok = (stdout: string): GitAnswer => ({ stdout });
const isBranch = (args: string[]): boolean => args.includes('--show-current');
const diffRange = (args: string[]): string | undefined => (args.includes('diff') ? args[args.length - 1] : undefined);

describe('GitInfoCollector.collectGitInfo', () => {
  it('uses base...HEAD diff when baseBranch is given', async () => {
    const { collector, calls } = makeCollector((args) => {
      if (isBranch(args)) return ok('task/1-x\n');
      if (diffRange(args) === 'main...HEAD') return ok('M\tsrc/a.ts\n');
      return ok('');
    });
    const info = await collector.collectGitInfo(server, '/w', 'main');
    expect(info.branch).toBe('task/1-x');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'M', file: 'src/a.ts' }]));
    expect(calls.some((c) => diffRange(c.args) === 'HEAD~1')).toBe(false);
  });

  it('runs git as an argv in the working directory (no shell line), whatever the directory is called', async () => {
    const dir = "/w/my repo 日本語/it's $(id);`x`";
    const { collector, calls } = makeCollector(() => ok('x'));
    await collector.collectGitInfo(server, dir);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.file).toBe('git');
      expect(c.cwd).toBe(dir);
    }
  });

  it('does not fall back to HEAD~1 when the base diff succeeds with zero changes', async () => {
    const { collector, calls } = makeCollector((args) => {
      if (isBranch(args)) return ok('task/1-x');
      if (diffRange(args) === 'main...HEAD') return ok('');
      if (diffRange(args) === 'HEAD~1') return ok('M\tstale.ts');
      return ok('');
    });
    const info = await collector.collectGitInfo(server, '/w', 'main');
    expect(info.changedFiles).toBeNull();
    expect(calls.some((c) => diffRange(c.args) === 'HEAD~1')).toBe(false);
  });

  it('falls back to HEAD~1 when the base diff fails with a git error (non-zero exit)', async () => {
    const { collector } = makeCollector((args) => {
      if (isBranch(args)) return ok('task/1-x');
      if (diffRange(args) === 'main...HEAD') return { fail: "fatal: bad revision 'main...HEAD'" };
      if (diffRange(args) === 'HEAD~1') return ok('A\tnew.ts');
      return ok('');
    });
    const info = await collector.collectGitInfo(server, '/w', 'main');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'A', file: 'new.ts' }]));
  });

  it('reports no branch and no files when git refuses everything (not a repository)', async () => {
    const { collector } = makeCollector(() => ({ fail: 'fatal: not a git repository' }));
    expect(await collector.collectGitInfo(server, '/w', 'main')).toEqual({ branch: null, changedFiles: null });
  });

  it('falls back to HEAD~1 when no baseBranch is given', async () => {
    const { collector, calls } = makeCollector((args) => {
      if (isBranch(args)) return ok('task/1-x');
      if (diffRange(args) === 'HEAD~1') return ok('D\told.ts');
      return ok('');
    });
    const info = await collector.collectGitInfo(server, '/w');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'D', file: 'old.ts' }]));
    expect(calls.some((c) => c.args.some((a) => a.includes('...HEAD')))).toBe(false);
  });

  it('falls back to HEAD~1 when baseBranch fails SAFE_BRANCH validation', async () => {
    const { collector, calls } = makeCollector((args) => {
      if (isBranch(args)) return ok('task/1-x');
      if (diffRange(args) === 'HEAD~1') return ok('M\tx.ts');
      return ok('');
    });
    const info = await collector.collectGitInfo(server, '/w', 'main; rm -rf /');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'M', file: 'x.ts' }]));
    expect(calls.some((c) => c.args.some((a) => a.includes('rm -rf')))).toBe(false);
  });

  it('reports an unsafe branch name as-is without touching PR/MR lookup (out of scope for this collector)', async () => {
    const { collector } = makeCollector((args) => (isBranch(args) ? ok('evil`whoami`') : ok('')));
    const info = await collector.collectGitInfo(server, '/w');
    expect(info.branch).toBe('evil`whoami`');
    expect('prUrl' in info).toBe(false);
  });

  it('does not hide a transport that cannot run git (unreachable agent) behind an empty result', async () => {
    const { collector } = makeCollector(() => new Error('Agent /api/run failed (503)'));
    await expect(collector.collectGitInfo(server, '/w', 'main')).rejects.toThrow('503');
  });
});

describe('GitInfoCollector.writeRemoteFile', () => {
  it('writes the text as UTF-8 through the host\'s file operations', async () => {
    const write = vi.fn(async () => ({ mtimeMs: 1, sha256: 'x' }));
    const files = { write } as unknown as IFileOps;
    const collector = new GitInfoCollector({ getFileOps: () => files } as unknown as TransportFactory);
    await collector.writeRemoteFile(server, 'C:\\Users\\u\\Temp\\azito-rules-1-n.md', "ルール\nit's $(id)\n");
    expect(write).toHaveBeenCalledWith('C:\\Users\\u\\Temp\\azito-rules-1-n.md', Buffer.from("ルール\nit's $(id)\n", 'utf-8'));
  });

  it('lets a failed write propagate', async () => {
    const files = { write: vi.fn(async () => { throw new Error('PERMISSION_DENIED'); }) } as unknown as IFileOps;
    const collector = new GitInfoCollector({ getFileOps: () => files } as unknown as TransportFactory);
    await expect(collector.writeRemoteFile(server, '/tmp/x.md', 'a')).rejects.toThrow('PERMISSION_DENIED');
  });
});
