import { describe, it, expect } from 'vitest';
import { PaneStreamFactory } from './PaneStreamFactory';

describe('PaneStreamFactory', () => {
  const server = { name: 's7', type: 'agent' as const, host: 'h', agentPort: 3002, agentToken: 't', muxRuntime: 'system' as const };
  const fileStream = { kind: 'file' };
  const transportFactory = { getTransport: () => ({ createPaneStream: () => fileStream }) } as never;
  const factory = new PaneStreamFactory(transportFactory);

  it('creates a pane stream via transport for agent servers', () => {
    expect(factory.create('%82', server)).toBe(fileStream);
  });
});
