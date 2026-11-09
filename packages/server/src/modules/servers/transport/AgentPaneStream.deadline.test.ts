import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTransport } from './AgentTransport';

const sockets = vi.hoisted(() => [] as Array<{ emit(event: string): boolean; terminate: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn> }>);
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Socket extends Emitter {
    ping = vi.fn();
    terminate = vi.fn(() => this.emit('close'));
    close = vi.fn();
    constructor() { super(); sockets.push(this); }
  }
  return { default: Socket };
});
import { AgentPaneStream } from './AgentPaneStream';

afterEach(() => { vi.useRealTimers(); sockets.length = 0; });

describe('agent pane stream deadlines', () => {
  it('reconnects after a stalled handshake and a half-open stream', async () => {
    vi.useFakeTimers();
    const transport = { registerPaneStreamFile: vi.fn(async () => {}), releasePaneStreamFile: vi.fn(async () => {}) } as unknown as AgentTransport;
    const stream = new AgentPaneStream('/tmp/test', transport, 'ws://example.invalid', 'Bearer token');
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    const socket = sockets[1];
    socket.emit('open');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).toHaveBeenCalledOnce();
    stream.stop();
  });
});
