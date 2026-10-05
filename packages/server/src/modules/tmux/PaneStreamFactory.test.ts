import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { PaneStreamFactory } from './PaneStreamFactory';
import { MisaoPaneStream } from './misao/MisaoPaneStream';
import type { MisaoLineSource } from './misao/MisaoConnection';

describe('PaneStreamFactory', () => {
  const server = { name: 's7', type: 'agent' as const, host: 'h', agentPort: 3002, agentToken: 't', defaultMux: 'tmux' as const, muxRuntime: 'system' as const };
  const fileStream = { kind: 'file' };
  const transportFactory = { getTransport: () => ({ createPaneStream: () => fileStream }) } as never;
  const factory = new PaneStreamFactory(transportFactory, () => ({} as MisaoLineSource));

  it('creates a pane stream via transport for agent servers', () => {
    expect(factory.create('%82', server)).toBe(fileStream);
  });

  describe('local servers', () => {
    const misaoServer = { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, defaultMux: 'misao' as const, muxRuntime: 'system' as const };
    const tmuxServer = { ...misaoServer, defaultMux: 'tmux' as const, muxRuntime: 'system' as const };
    const misaoLines = {} as MisaoLineSource;
    const linesOf = vi.fn((_server: { name: string }) => misaoLines);
    const misaoFactory = new PaneStreamFactory(transportFactory, linesOf);

    const misaoPane = asPaneHandle('p_01ARZ3NDEKTSV4RRFFQ69G5FAV');

    it('reads a misao pane through its line stream', () => {
      expect(misaoFactory.create('t1-123', misaoServer, misaoPane)).toBeInstanceOf(MisaoPaneStream);
    });

    it('reads a misao pane of an agent server through the line stream of that server', () => {
      expect(misaoFactory.create('t1-123', server, misaoPane)).toBeInstanceOf(MisaoPaneStream);
      expect(linesOf).toHaveBeenLastCalledWith(server);
    });

    it('tells a misao pane by its handle, whatever the server default mux is', () => {
      expect(misaoFactory.create('t1-123', tmuxServer, misaoPane)).toBeInstanceOf(MisaoPaneStream);
    });

    it('takes streams without a pane (signal files) from the transport, which writes a plain file', () => {
      expect(misaoFactory.create('t1-sig', misaoServer)).toBe(fileStream);
    });

    it('keeps the transport path for a tmux pane, even on a misao-default server', () => {
      expect(misaoFactory.create('t1-123', tmuxServer, asPaneHandle('%5'))).toBe(fileStream);
      expect(misaoFactory.create('t1-123', misaoServer, asPaneHandle('%5'))).toBe(fileStream);
    });
  });
});
