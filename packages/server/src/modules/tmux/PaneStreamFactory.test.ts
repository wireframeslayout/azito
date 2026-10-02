import { describe, it, expect } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { PaneStreamFactory } from './PaneStreamFactory';
import { PaneOutputStream } from './PaneOutputStream';
import { MisaoPaneStream } from './misao/MisaoPaneStream';
import type { MisaoLineSource, MisaoRpc } from './misao/MisaoConnection';

describe('PaneStreamFactory', () => {
  const server = { name: 's7', type: 'agent' as const, host: 'h', agentPort: 3002, agentToken: 't', muxRuntime: 'system' as const };
  const fileStream = { kind: 'file' };
  const transportFactory = { getTransport: () => ({ createPaneStream: () => fileStream }) } as never;
  const factory = new PaneStreamFactory(transportFactory);

  it('creates a pane stream via transport for agent servers', () => {
    expect(factory.create('%82', server)).toBe(fileStream);
  });

  describe('local servers', () => {
    const misaoServer = { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, muxRuntime: 'misao' as const };
    const tmuxServer = { ...misaoServer, muxRuntime: 'system' as const };
    const misaoLines = {} as MisaoLineSource & MisaoRpc;
    const misaoFactory = new PaneStreamFactory(transportFactory, misaoLines);
    const pane = asPaneHandle('p_1');

    it('reads a misao pane through its line stream', () => {
      expect(misaoFactory.create('t1-123', misaoServer, pane)).toBeInstanceOf(MisaoPaneStream);
    });

    it('uses a plain file stream for misao streams without a pane (signal files)', () => {
      const stream = misaoFactory.create('t1-sig', misaoServer);
      expect(stream).toBeInstanceOf(PaneOutputStream);
      expect(stream.getFilePath()).toContain('azito-pipe-t1-sig-');
    });

    it('keeps the transport path when the misao line source is not wired', () => {
      expect(factory.create('t1-123', misaoServer, pane)).toBe(fileStream);
    });

    it('keeps the transport path for tmux servers', () => {
      expect(misaoFactory.create('t1-123', tmuxServer, pane)).toBe(fileStream);
    });
  });
});
