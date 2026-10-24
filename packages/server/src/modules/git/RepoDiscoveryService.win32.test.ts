import { describe, expect, it } from 'vitest';
import { RepoDiscoveryService } from './RepoDiscoveryService';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ServerConfig } from '../servers/Server';
import type { IFileOps } from '../../shared/fs/fileOps';
import type { CommandSpec } from '../../shared/exec/commandSpec';
import { ok } from '../../shared/exec/testing/commandTesting';

/** A Windows host: directories keyed by their listing path, git printing forward slashes as Git for Windows does. */
function winFactory(tree: Record<string, Array<[string, 'file' | 'directory']>>, toplevels: Record<string, string>): TransportFactory {
  const files = {
    platform: 'win32',
    list: async (dir: string) => (tree[dir] ?? []).map(([name, kind]) => ({ name, kind })),
  } as unknown as IFileOps;
  const transport = {
    files: () => files,
    run: async (spec: CommandSpec) => {
      if (spec.args[0] === '--version') return ok('git version 2.47.0.windows.1\n');
      if (spec.args[2] === 'rev-parse') return ok(`${toplevels[spec.args[1]]}\n`);
      return ok('origin\thttps://github.com/acme/widgets.git (fetch)\n');
    },
  };
  return { getTransport: () => transport } as unknown as TransportFactory;
}

const server = { name: 'win', type: 'agent' } as unknown as ServerConfig;

describe('RepoDiscoveryService on a Windows host', () => {
  it('finds `.git` by the host name rules and reports paths in the host spelling, relative to the scanned directory', async () => {
    const factory = winFactory(
      {
        'C:\\Users\\x y': [['日本語', 'directory'], ['Other', 'directory'], ['node_modules', 'directory']],
        'C:\\Users\\x y\\日本語': [['.GIT', 'directory'], ['sub', 'directory']],
        'C:\\Users\\x y\\日本語\\sub': [['.git', 'file']],
        'C:\\Users\\x y\\Other': [],
      },
      {
        'C:\\Users\\x y\\日本語': 'C:/Users/x y/日本語',
        'C:\\Users\\x y\\日本語\\sub': 'C:/users/X Y/日本語/sub',
      },
    );

    const repos = await new RepoDiscoveryService(factory).discover(server, 'C:\\Users\\x y');

    expect(repos.map((r) => [r.absolutePath, r.relativePath])).toEqual([
      ['C:\\Users\\x y\\日本語', '日本語'],
      ['C:\\users\\X Y\\日本語\\sub', '日本語\\sub'],
    ]);
  });

  it('reports the scanned directory itself as "." even when git spells it differently', async () => {
    const factory = winFactory({ 'C:\\repo\\': [['.git', 'directory']] }, { 'C:\\repo\\': 'c:/repo' });
    const repos = await new RepoDiscoveryService(factory).discover(server, 'C:\\repo\\');
    expect(repos.map((r) => [r.absolutePath, r.relativePath])).toEqual([['c:\\repo', '.']]);
  });

  it('keeps a repository outside the scanned directory as its absolute path', async () => {
    const factory = winFactory({ 'C:\\work': [['link', 'directory']], 'C:\\work\\link': [['.git', 'file']] }, { 'C:\\work\\link': 'D:/elsewhere/repo' });
    const repos = await new RepoDiscoveryService(factory).discover(server, 'C:\\work');
    expect(repos.map((r) => [r.absolutePath, r.relativePath])).toEqual([['D:\\elsewhere\\repo', 'D:\\elsewhere\\repo']]);
  });
});
