import { describe, it, expect, vi } from 'vitest';
import { RepoDiscoveryService } from './RepoDiscoveryService';
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
});
