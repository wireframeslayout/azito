import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessCommand } from './headlessExec';

interface FakeProcess extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

const spawnMock = vi.fn();
const findMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('./windowsHeadlessCommand', () => ({
  findWindowsHeadlessCommand: (...args: unknown[]) => findMock(...args),
  windowsSystemCommand: (root: string | undefined) => root === 'C:\\Windows' ? 'C:\\Windows\\System32\\taskkill.exe' : undefined,
  windowsShimCommand: () => { throw new Error('not a shim'); },
  UnsafeShimArgumentError: class extends Error {},
}));

function fakeProcess(pid: number): FakeProcess {
  return Object.assign(new EventEmitter(), {
    pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
}

// vi.waitFor would advance fake timers and could fire the timeout early.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('runHeadlessCommand terminate on Windows', () => {
  const platform = process.platform;
  const systemRoot = process.env.SystemRoot;
  let child: FakeProcess;
  let killers: FakeProcess[];

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.SystemRoot = 'C:\\Windows';
    killers = [];
    child = fakeProcess(4242);
    findMock.mockReset();
    findMock.mockResolvedValue({ file: 'C:\\tools\\codex.exe', search: { directories: [], extensions: [] } });
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string) => {
      if (/taskkill\.exe$/i.test(command)) { const killer = fakeProcess(1); killers.push(killer); return killer; }
      return child;
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    vi.useRealTimers();
  });

  it('times out during PATH search without spawning', async () => {
    vi.useFakeTimers();
    findMock.mockReturnValue(new Promise(() => {}));
    const run = runHeadlessCommand('codex', [], 'C:\\work', '', 1_000);
    const assertion = expect(run).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the remaining time after PATH search', async () => {
    vi.useFakeTimers();
    findMock.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ file: 'C:\\tools\\codex.exe', search: { directories: [], extensions: [] } }), 600)));
    const run = runHeadlessCommand('codex', [], 'C:\\work', '', 1_000);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(400);
    expect(killers).toHaveLength(1);
    child.emit('close', 1);
    await expect(run).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('kills directly when SystemRoot is relative', async () => {
    vi.useFakeTimers();
    process.env.SystemRoot = 'relative';
    const run = runHeadlessCommand('codex', [], 'C:\\work', '', 100);
    await flushMicrotasks();
    vi.advanceTimersByTime(100);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killers).toHaveLength(0);
    child.emit('close', 1);
    await expect(run).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('starts taskkill once when output keeps overflowing and the timer fires later', async () => {
    vi.useFakeTimers();
    const run = runHeadlessCommand('codex', [], 'C:\\work', '', 1_000);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const big = Buffer.alloc(600_000, 'a');
    for (let i = 0; i < 4; i++) child.stdout.emit('data', big);
    vi.advanceTimersByTime(1_000);

    expect(killers).toHaveLength(1);
    expect(spawnMock.mock.calls[1]).toEqual([
      'C:\\Windows\\System32\\taskkill.exe', ['/pid', '4242', '/t', '/f'], { stdio: 'ignore' },
    ]);
    killers[0].emit('close', 0);
    child.emit('close', 1);
    await expect(run).rejects.toMatchObject({ reason: 'failed' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports a timeout and starts taskkill once', async () => {
    vi.useFakeTimers();
    const run = runHeadlessCommand('codex', [], 'C:\\work', '', 1_000);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    child.stdout.emit('data', Buffer.alloc(1_100_000, 'a'));

    expect(killers).toHaveLength(1);
    killers[0].emit('close', 0);
    child.emit('close', 1);
    await expect(run).rejects.toMatchObject({ reason: 'timeout' });
  });
});
