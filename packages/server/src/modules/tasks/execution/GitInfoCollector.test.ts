import { describe, it, expect, vi } from 'vitest';
import { GitInfoCollector } from './GitInfoCollector';
import type { TmuxClient } from '../../tmux/TmuxClient';
import type { ServerConfig } from '../../servers/Server';

const server = { name: 'remote', type: 'agent' } as ServerConfig;

interface FakeExec {
  (cmd: string): { stdout: string; stderr: string; code: number } | Error;
}

function makeCollector(handler: FakeExec): { collector: GitInfoCollector; commands: string[] } {
  const commands: string[] = [];
  const tmux = {
    execCommand: vi.fn(async (_srv: ServerConfig, cmd: string) => {
      commands.push(cmd);
      const result = handler(cmd);
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as TmuxClient;
  return { collector: new GitInfoCollector(tmux), commands };
}

const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });

describe('GitInfoCollector.collectGitInfoRemote', () => {
  it('uses base...HEAD diff when baseBranch is given', async () => {
    const { collector, commands } = makeCollector((cmd) => {
      if (cmd.includes('branch --show-current')) return ok('task/1-x');
      if (cmd.includes('main...HEAD')) return ok('M\tsrc/a.ts');
      return ok('');
    });
    const info = await collector.collectGitInfoRemote(server, '/w', 'main');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'M', file: 'src/a.ts' }]));
    expect(commands.some((c) => c.includes('main...HEAD'))).toBe(true);
    expect(commands.some((c) => c.includes('HEAD~1'))).toBe(false);
  });

  it('does not fall back to HEAD~1 when the base diff succeeds with zero changes', async () => {
    const { collector, commands } = makeCollector((cmd) => {
      if (cmd.includes('branch --show-current')) return ok('task/1-x');
      if (cmd.includes('main...HEAD')) return ok('');
      if (cmd.includes('HEAD~1')) return ok('M\tstale.ts');
      return ok('');
    });
    const info = await collector.collectGitInfoRemote(server, '/w', 'main');
    expect(info.changedFiles).toBeNull();
    expect(commands.some((c) => c.includes('HEAD~1'))).toBe(false);
  });

  it('falls back to HEAD~1 when the base diff fails with a git error', async () => {
    const { collector } = makeCollector((cmd) => {
      if (cmd.includes('branch --show-current')) return ok('task/1-x');
      if (cmd.includes('main...HEAD')) return ok("fatal: bad revision 'main...HEAD'");
      if (cmd.includes('HEAD~1')) return ok('A\tnew.ts');
      return ok('');
    });
    const info = await collector.collectGitInfoRemote(server, '/w', 'main');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'A', file: 'new.ts' }]));
  });

  it('falls back to HEAD~1 when no baseBranch is given', async () => {
    const { collector, commands } = makeCollector((cmd) => {
      if (cmd.includes('branch --show-current')) return ok('task/1-x');
      if (cmd.includes('HEAD~1')) return ok('D\told.ts');
      return ok('');
    });
    const info = await collector.collectGitInfoRemote(server, '/w');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'D', file: 'old.ts' }]));
    expect(commands.some((c) => c.includes('...HEAD'))).toBe(false);
  });

  it('falls back to HEAD~1 when baseBranch fails SAFE_BRANCH validation', async () => {
    const { collector, commands } = makeCollector((cmd) => {
      if (cmd.includes('branch --show-current')) return ok('task/1-x');
      if (cmd.includes('HEAD~1')) return ok('M\tx.ts');
      return ok('');
    });
    const info = await collector.collectGitInfoRemote(server, '/w', 'main; rm -rf /');
    expect(info.changedFiles).toBe(JSON.stringify([{ status: 'M', file: 'x.ts' }]));
    expect(commands.some((c) => c.includes('rm -rf'))).toBe(false);
  });

  it('reports an unsafe branch name as-is without touching PR/MR lookup (out of scope for this collector)', async () => {
    const { collector } = makeCollector((cmd) => {
      if (cmd.includes('branch --show-current')) return ok('evil`whoami`');
      return ok('');
    });
    const info = await collector.collectGitInfoRemote(server, '/w');
    expect(info.branch).toBe('evil`whoami`');
    expect('prUrl' in info).toBe(false);
  });
});
