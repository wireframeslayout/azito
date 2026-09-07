import { describe, it, expect } from 'vitest';
import { PaneStreamFactory, isHerdrPaneId } from './PaneStreamFactory';
import { HerdrPaneStream } from '../mux/herdr/HerdrPaneStream';

// On a herdr server WorkerWaiter creates two streams: the pane stream (herdr pane id) and the
// completion-signal file tail (`<taskId>-sig`). Only the former may go through pane.read.
describe('PaneStreamFactory (herdr routing)', () => {
  const server = { name: 's7', type: 'agent' as const, host: 'h', agentPort: 3002, agentToken: 't', muxRuntime: 'herdr' as const };
  const fileStream = { kind: 'file' };
  const transportFactory = { getTransport: () => ({ createPaneStream: () => fileStream, execMux: async () => ({ stdout: '{}', stderr: '', code: 0 }) }) } as never;
  const factory = new PaneStreamFactory(transportFactory);

  it('recognises herdr pane ids', () => {
    expect(isHerdrPaneId('w1:p4')).toBe(true);
    expect(isHerdrPaneId('389-1788781633841')).toBe(false);
    expect(isHerdrPaneId('%82')).toBe(false);
  });

  it('serves a herdr pane id with HerdrPaneStream', () => {
    expect(factory.create('w1:p4', server)).toBeInstanceOf(HerdrPaneStream);
  });

  it('serves the signal-file key with the transport file stream even on a herdr server', () => {
    expect(factory.create('389-sig', server)).toBe(fileStream);
  });
});
