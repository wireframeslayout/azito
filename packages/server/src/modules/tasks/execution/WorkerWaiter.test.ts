import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { asPaneHandle } from '@azito/shared';
import { WorkerWaiter, choosePlanExtractionSource } from './WorkerWaiter';
import type { IPaneStream } from '../../tmux/PaneStream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaneOutputStream } from '../../tmux/PaneOutputStream';
import type { ServerConfig } from '../../servers/Server';

const server = { name: 'local', type: 'local', defaultMux: 'misao' as const, muxRuntime: 'system' } as ServerConfig;
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

const tempServer = { type: 'local' as const };

describe('WorkerWaiter.startPaneStream', () => {
  it('passes the real pane to the stream factory and pipes tmux-style file streams', () => {
    const { waiter, create, driver } = setup('/tmp/azito-pipe-1.log');
    waiter.startPaneStream(server, tempServer, handle, 1, 2);
    expect(create).toHaveBeenCalledWith(expect.stringMatching(/^1-\d+$/), server, tempServer, handle);
    expect(driver.startOutputStream).toHaveBeenCalledWith(server, handle, '/tmp/azito-pipe-1.log');
  });

  it('does not start a pipe for a stream without an output file (misao line stream)', () => {
    const { waiter, stream, driver } = setup('');
    expect(waiter.startPaneStream(server, tempServer, handle, 1, 2)).toBe(stream);
    expect(stream.start).toHaveBeenCalled();
    expect(driver.startOutputStream).not.toHaveBeenCalled();
  });
});

describe('WorkerWaiter.startPaneStream stream events', () => {
  it('logs gaps and subscription errors, including ones reported during start()', () => {
    const { waiter, stream, appendLog } = setup('');
    stream.start.mockImplementation(() => { stream.emit('subscription_error', new Error('pane not found')); });
    waiter.startPaneStream(server, tempServer, handle, 1, 2);
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

describe('choosePlanExtractionSource', () => {
  const long = 'x'.repeat(1000);
  it('tmux prefers the pane capture over a longer pipe output', () => {
    expect(choosePlanExtractionSource('tmux', 'pane', long)).toBe('pane');
  });
  it('tmux falls back to pipe output when the pane capture is empty', () => {
    expect(choosePlanExtractionSource('tmux', '', 'pipe')).toBe('pipe');
  });
  it('tmux returns empty when both are empty', () => {
    expect(choosePlanExtractionSource('tmux', '', '')).toBe('');
  });
  it('misao prefers pipe output', () => {
    expect(choosePlanExtractionSource('misao', 'pane', 'pipe')).toBe('pipe');
  });
  it('misao falls back to pane text when pipe output is empty', () => {
    expect(choosePlanExtractionSource('misao', 'pane', '')).toBe('pane');
  });
  it('misao returns empty when both are empty', () => {
    expect(choosePlanExtractionSource('misao', '', '')).toBe('');
  });
});

describe('WorkerWaiter.extractPlanWithFallback', () => {
  function setupPlan(screen: string) {
    const captureScreen = vi.fn(async () => ({ stdout: screen }));
    const extractPlan = vi.fn(async () => ({ planMarkdown: null }));
    const waiter = new WorkerWaiter(
      { resolve: () => ({ captureScreen }) } as never, {} as never, {} as never,
      { extractPlan } as never, { create: vi.fn() }, vi.fn(), () => {}, {} as never,
    );
    return { captureScreen, extractPlan, waiter };
  }
  const plan = '## 実装計画\n' + '- step\n'.repeat(200);

  it('misao: extracts from the accumulated pipe output without capturing the screen', async () => {
    const { waiter, captureScreen, extractPlan } = setupPlan('visible only');
    const result = await waiter.extractPlanWithFallback(server, asPaneHandle('p_01HZZZZZZZZZZZZZZZZZZZZZZZ'), plan);
    expect(captureScreen).not.toHaveBeenCalled();
    expect(extractPlan).toHaveBeenCalledWith(expect.stringContaining('- step'));
    expect(result).toContain('## 実装計画');
    expect(result).toContain('- step');
  });

  it('tmux: extracts from the scrollback capture', async () => {
    const { waiter, captureScreen, extractPlan } = setupPlan(plan);
    const result = await waiter.extractPlanWithFallback(server, asPaneHandle('%0'), 'unused pipe');
    expect(captureScreen).toHaveBeenCalledWith(server, '%0', -3000);
    expect(extractPlan).toHaveBeenCalledWith(expect.stringContaining('## 実装計画'));
    expect(result).toContain('## 実装計画');
  });
});

describe('WorkerWaiter with a local file stream that fails', () => {
  it('ends only that wait as stopped, with the read error as the reason', async () => {
    const file = path.join(os.tmpdir(), `azito-pipe-waiter-${Date.now()}.log`);
    const real = new PaneOutputStream(file);
    const waiter = new WorkerWaiter(
      { resolve: () => ({ startOutputStream: async () => undefined, stopOutputStream: async () => undefined }) } as never,
      {} as never, {} as never, {} as never, { create: () => real }, vi.fn(), () => {}, {} as never,
    );
    waiter.startPaneStream(server, tempServer, handle, 1, 2);
    real.on('data', () => { throw new Error('disk read failed'); });
    const waiting = waiter.waitForWorker(server, handle, 1, 2, new AbortController().signal, real);
    fs.appendFileSync(file, 'x\n');
    await expect(waiting).resolves.toMatchObject({ classification: { status: 'stopped', reason: 'disk read failed' } });
    expect(waiter.streamFailure(real)?.message).toBe('disk read failed');
  });
});

describe('WorkerWaiter stream_failed', () => {
  it('ends the wait as a stopped worker when a stream fails during it, and releases the stream', async () => {
    const { waiter, stream, appendLog } = setup('/tmp/azito-pipe-1.log');
    waiter.startPaneStream(server, tempServer, handle, 1, 2);
    const waiting = waiter.waitForWorker(server, handle, 1, 2, new AbortController().signal, stream as unknown as IPaneStream);
    stream.emit('stream_failed', new Error('agent_outdated: x'));
    await expect(waiting).resolves.toMatchObject({ classification: { status: 'stopped' } });
    expect(stream.stop).toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'pane_stream_failed', message: 'agent_outdated: x' });
  });

  it('also ends it when the stream failed before the wait began', async () => {
    const { waiter, stream } = setup('/tmp/azito-pipe-1.log');
    waiter.startPaneStream(server, tempServer, handle, 1, 2);
    stream.emit('stream_failed', new Error('early'));
    const waiting = waiter.waitForWorker(server, handle, 1, 2, new AbortController().signal, stream as unknown as IPaneStream);
    await expect(waiting).resolves.toMatchObject({ classification: { status: 'stopped' } });
    expect(stream.stop).toHaveBeenCalled();
  });

  it('does not throw for a failure nobody is waiting on (no error event)', () => {
    const { waiter, stream } = setup('');
    waiter.startPaneStream(server, tempServer, handle, 1, 2);
    expect(() => stream.emit('stream_failed', new Error('late'))).not.toThrow();
  });
});
