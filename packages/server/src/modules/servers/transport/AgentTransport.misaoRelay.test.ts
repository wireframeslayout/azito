import { afterEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => [] as Array<{ terminate: () => void; emit: (event: string, ...args: unknown[]) => boolean }>);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    terminate = vi.fn();
    constructor() { super(); sockets.push(this); }
  }
  return { default: Socket, createWebSocketStream: vi.fn() };
});
import { AgentTransport } from './AgentTransport';

afterEach(() => { vi.useRealTimers(); sockets.length = 0; });

describe('misao relay deadline', () => {
  it('terminates a stalled connection and opens the shared circuit', async () => {
    vi.useFakeTimers();
    const transport = new AgentTransport('unused', 1, 'token', 'system', 'server', null);
    const attempt = transport.connectMisaoRelay(new AbortController().signal);
    const rejected = expect(attempt).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(4_000);
    await rejected;
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    await expect(transport.connectMisaoRelay(new AbortController().signal)).rejects.toMatchObject({ reason: 'circuit_open' });
    expect(sockets).toHaveLength(1);
  });

  it('does not open the circuit when the agent rejects the websocket handshake', async () => {
    const transport = new AgentTransport('unused', 1, 'token', 'system', 'server', null);
    const attempt = transport.connectMisaoRelay(new AbortController().signal);
    sockets[0].emit('unexpected-response', {}, { statusCode: 401 });
    await expect(attempt).rejects.toThrow('401');
    expect(transport.isCircuitOpen()).toBe(false);
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
  });

  it('terminates an aborted attempt without opening the circuit', async () => {
    const transport = new AgentTransport('unused', 1, 'token', 'system', 'server', null);
    const controller = new AbortController();
    const attempt = transport.connectMisaoRelay(controller.signal);
    controller.abort();
    await expect(attempt).rejects.toThrow('aborted');
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    expect(transport.isCircuitOpen()).toBe(false);
  });
});
