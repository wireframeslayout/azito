import { describe, it, expect, vi } from 'vitest';
import { WorktreeServiceFactory } from './WorktreeServiceFactory';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';

describe('WorktreeServiceFactory', () => {
  const factory = new WorktreeServiceFactory();
  const transport = { run: vi.fn(), files: vi.fn() } as unknown as IServerTransport;

  it('returns a RemoteWorktreeService over the transport, for a local server as for an agent or ssh one', () => {
    expect(factory.create(transport)).toBeInstanceOf(RemoteWorktreeService);
  });
});
