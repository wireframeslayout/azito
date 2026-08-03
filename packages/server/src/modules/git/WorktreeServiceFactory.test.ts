import { describe, it, expect, vi } from 'vitest';
import { WorktreeServiceFactory } from './WorktreeServiceFactory';
import { LocalWorktreeService } from './WorktreeService';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';

describe('WorktreeServiceFactory', () => {
  const factory = new WorktreeServiceFactory();

  it('returns LocalWorktreeService for local server type', () => {
    const service = factory.create('local');
    expect(service).toBeInstanceOf(LocalWorktreeService);
  });

  it('returns the same LocalWorktreeService instance each time', () => {
    const a = factory.create('local');
    const b = factory.create('local');
    expect(a).toBe(b);
  });

  it('returns RemoteWorktreeService for ssh server type', () => {
    const transport = { exec: vi.fn() } as unknown as IServerTransport;
    const service = factory.create('ssh', transport);
    expect(service).toBeInstanceOf(RemoteWorktreeService);
  });

  it('returns RemoteWorktreeService for agent server type', () => {
    const transport = { exec: vi.fn() } as unknown as IServerTransport;
    const service = factory.create('agent', transport);
    expect(service).toBeInstanceOf(RemoteWorktreeService);
  });

  it('throws when transport is not provided for remote server type', () => {
    expect(() => factory.create('ssh')).toThrow('Transport required for remote worktree operations');
    expect(() => factory.create('agent')).toThrow('Transport required for remote worktree operations');
  });
});
