import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { asPaneHandle } from '@azito/shared';
import { WorkerWaiter } from './WorkerWaiter';
import type { IPaneStream } from '../../tmux/PaneStream';
import type { ServerConfig } from '../../servers/Server';

const server = { name: 'local', type: 'local', muxRuntime: 'misao' } as ServerConfig;
const handle = asPaneHandle('p_1');

class FakeStream extends EventEmitter {
  constructor(private readonly filePath: string) { super(); }
  setMarkers = vi.fn();
  getFilePath = (): string => this.filePath;
  enableMarkerDetection = vi.fn();
  start = vi.fn();
  getBuffer = (): string => '';
  stop = vi.fn();
}

function setup(filePath: string) {
  const stream = new FakeStream(filePath);
  const create = vi.fn(() => stream as unknown as IPaneStream);
  const driver = { startOutputStream: vi.fn(async () => undefined), stopOutputStream: vi.fn(async () => undefined) };
  const appendLog = vi.fn();
  const waiter = new WorkerWaiter(
    { resolve: () => driver } as never, {} as never, {} as never, {} as never,
    { create }, appendLog, () => {}, {} as never,
  );
  return { stream, create, driver, appendLog, waiter };
}

describe('WorkerWaiter.startPaneStream', () => {
  it('passes the real pane to the stream factory and pipes tmux-style file streams', () => {
    const { waiter, create, driver } = setup('/tmp/azito-pipe-1.log');
    waiter.startPaneStream(server, handle, 1, 2);
    expect(create).toHaveBeenCalledWith(expect.stringMatching(/^1-\d+$/), server, handle);
    expect(driver.startOutputStream).toHaveBeenCalledWith(server, handle, '/tmp/azito-pipe-1.log');
  });

  it('does not start a pipe for a stream without an output file (misao line stream)', () => {
    const { waiter, stream, driver } = setup('');
    expect(waiter.startPaneStream(server, handle, 1, 2)).toBe(stream);
    expect(stream.start).toHaveBeenCalled();
    expect(driver.startOutputStream).not.toHaveBeenCalled();
  });
});

describe('WorkerWaiter.startPaneStream stream events', () => {
  it('logs gaps and subscription errors, including ones reported during start()', () => {
    const { waiter, stream, appendLog } = setup('');
    stream.start.mockImplementation(() => { stream.emit('subscription_error', new Error('pane not found')); });
    waiter.startPaneStream(server, handle, 1, 2);
    stream.emit('gap', { reason: 'epoch' });
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'pane_stream_subscription_error', message: 'pane not found' });
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'pane_stream_gap', reason: 'epoch' });
  });
});

describe('WorkerWaiter.waitForWorker cleanup', () => {
  it.each([
    ['stops the pipe of a file-backed stream', '/tmp/azito-pipe-1.log', 1],
    ['does not stop a pipe that was never started (no output file)', '', 0],
  ])('%s', async (_name, filePath, stopCalls) => {
    const { waiter, stream, driver } = setup(filePath);
    const abort = new AbortController();
    const waiting = waiter.waitForWorker(server, handle, 1, 2, abort.signal, stream as unknown as IPaneStream);
    abort.abort();
    await waiting;
    expect(driver.stopOutputStream).toHaveBeenCalledTimes(stopCalls);
    expect(stream.stop).toHaveBeenCalled();
  });
});
