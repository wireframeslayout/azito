import { describe, it, expect } from 'vitest';
import { runGit } from './runGit';
import { resolveGitPath, type GitTransport } from './gitPath';
import type { CommandSpec } from '../../shared/exec/commandSpec';
import type { HostPlatform } from '../../shared/os/hostEnv';
import type { IFileOps } from '../../shared/fs/fileOps';
import { ok } from '../../shared/exec/testing/commandTesting';

function transportOf(platform: HostPlatform, home: string): { transport: GitTransport; specs: CommandSpec[]; realpaths: string[] } {
  const specs: CommandSpec[] = [];
  const realpaths: string[] = [];
  const files = {
    platform,
    realpath: async (p: string) => { realpaths.push(p); return `${home}${p.slice(1)}`; },
  } as unknown as IFileOps;
  return { transport: { run: async (spec) => { specs.push(spec); return ok(); }, files: () => files }, specs, realpaths };
}

describe('runGit: a leading ~ is the host home, resolved once for every git path', () => {
  it('resolves cwd', async () => {
    const { transport, specs } = transportOf('linux', '/home/u');
    await runGit(transport, '~/repo', ['status']);
    expect(specs[0]).toMatchObject({ file: 'git', args: ['status'], cwd: '/home/u/repo' });
  });

  it('resolves the -C directory, after global -c options', async () => {
    const { transport, specs } = transportOf('linux', '/home/u');
    await runGit(transport, undefined, ['-c', 'core.quotepath=false', '-C', '~/repo', 'log', '-n', '1']);
    expect(specs[0].args).toEqual(['-c', 'core.quotepath=false', '-C', '/home/u/repo', 'log', '-n', '1']);
  });

  it('resolves ~\\ on a Windows host', async () => {
    const { transport, specs } = transportOf('win32', 'C:\\Users\\me');
    await runGit(transport, undefined, ['-C', '~\\repo', 'status']);
    expect(specs[0].args).toEqual(['-C', 'C:\\Users\\me\\repo', 'status']);
  });

  it('does not touch a -C-looking argument after the subcommand, or an absolute path (no round trip)', async () => {
    const { transport, specs, realpaths } = transportOf('linux', '/home/u');
    await runGit(transport, '/abs/repo', ['log', '-C', '~/not-a-dir']);
    await runGit(transport, undefined, ['-C', '/abs/repo', 'status']);
    expect(realpaths).toEqual([]);
    expect(specs[0].args).toEqual(['log', '-C', '~/not-a-dir']);
  });

  it('does not treat ~\\ as home on a POSIX host', async () => {
    const { transport, realpaths } = transportOf('linux', '/home/u');
    expect(await resolveGitPath(transport, '~\\x')).toBe('~\\x');
    expect(realpaths).toEqual([]);
  });

  it('fails instead of passing "~" on to git when the transport cannot resolve it', async () => {
    await expect(resolveGitPath({ run: async () => ok() }, '~/repo')).rejects.toThrow(/Cannot resolve/);
  });
});
