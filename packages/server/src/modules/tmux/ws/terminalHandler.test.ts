import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { MuxRef, PaneOrdinal } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { handleTerminalConnection } from './terminalHandler';

const OPEN = 1;
const ref = { kind: 'misao', workspace: 'w', window: 'w_1' } as MuxRef;
const tmuxServer = { name: 'local', type: 'local', defaultMux: 'tmux' as const, muxRuntime: 'system' } as ServerConfig;
const misaoServer = { name: 'local', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system' } as ServerConfig;

function fakeWs() {
  const ws = Object.assign(new EventEmitter(), { OPEN, readyState: OPEN, send: vi.fn(), close: vi.fn(), ping: vi.fn(), terminate: vi.fn() });
  return ws;
}

function fixtures() {
  const stream = Object.assign(new EventEmitter(), { write: vi.fn(), resize: vi.fn(), close: vi.fn() });
  const tmuxOpen = vi.fn(async () => stream);
  const getTransport = vi.fn(() => ({ openTerminal: tmuxOpen }));
  const transportFactory = { getTransport } as unknown as TransportFactory;
  const misaoOpen = vi.fn(async () => stream);
  const registry = new MuxDriverRegistry();
  const resolve = vi.spyOn(registry, 'resolve').mockReturnValue({ openTerminal: misaoOpen } as never);
  return { stream, tmuxOpen, getTransport, transportFactory, misaoOpen, registry, resolve };
}

function connect(ws: ReturnType<typeof fakeWs>, server: ServerConfig, f: ReturnType<typeof fixtures>): void {
  handleTerminalConnection(ws as unknown as WebSocket, server, ref, 1 as PaneOrdinal, 100, 30, f.transportFactory, f.registry);
}

describe('handleTerminalConnection driver selection', () => {
  it('opens a tmux server through the transport and never touches the registry', async () => {
    const f = fixtures();
    const ws = fakeWs();
    connect(ws, tmuxServer, f);
    await vi.waitFor(() => expect(f.tmuxOpen).toHaveBeenCalledWith(ref, 1, 100, 30, undefined));
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it('opens a misao server through the driver and never touches the transport factory', async () => {
    const f = fixtures();
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(f.misaoOpen).toHaveBeenCalledWith(misaoServer, ref, 1, 100, 30));
    expect(f.getTransport).not.toHaveBeenCalled();
  });

  it('relays the stream both ways for a misao server', async () => {
    const f = fixtures();
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(f.misaoOpen).toHaveBeenCalled());
    await vi.waitFor(() => expect(ws.listenerCount('message')).toBe(1));
    f.stream.emit('data', 'out');
    expect(ws.send).toHaveBeenCalledWith('out');
    ws.emit('message', 'in');
    ws.emit('message', JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
    expect(f.stream.write).toHaveBeenCalledWith('in');
    expect(f.stream.resize).toHaveBeenCalledWith(90, 20);
  });

  it('closes the stream when the socket closes', async () => {
    const f = fixtures();
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(ws.listenerCount('message')).toBe(1));
    ws.emit('close');
    expect(f.stream.close).toHaveBeenCalled();
  });

  it('maps WINDOW_NOT_FOUND to close code 4404', async () => {
    const f = fixtures();
    f.misaoOpen.mockRejectedValueOnce(new Error('WINDOW_NOT_FOUND'));
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(4404, 'window not found'));
  });

  it.each([
    ['PANE_STOPPED', 4410, 'pane stopped'],
    ['WINDOW_EMPTY', 4412, 'window empty'],
    ['PANE_CLOSED', 4413, 'pane closed'],
  ])('maps %s to close code %i', async (message, code, reason) => {
    const f = fixtures();
    f.misaoOpen.mockRejectedValueOnce(new Error(message));
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(code, reason));
  });

  it('closes the socket with the stream\'s own close code when it has one, and without a code otherwise', async () => {
    const f = fixtures();
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(ws.listenerCount('message')).toBe(1));
    Object.assign(f.stream, { closeCode: 4413, closeReason: 'pane closed' });
    f.stream.emit('close');
    expect(ws.close).toHaveBeenCalledWith(4413, 'pane closed');

    const g = fixtures();
    const plain = fakeWs();
    connect(plain, misaoServer, g);
    await vi.waitFor(() => expect(plain.listenerCount('message')).toBe(1));
    g.stream.emit('close');
    expect(plain.close).toHaveBeenCalledWith();
  });

  it('sends the message and closes when the misao driver is unavailable', async () => {
    const f = fixtures();
    f.resolve.mockImplementation(() => { throw new MuxDriverUnavailableError('misao', 'daemon_unreachable'); });
    const ws = fakeWs();
    connect(ws, misaoServer, f);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith());
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('misao'));
  });
});
