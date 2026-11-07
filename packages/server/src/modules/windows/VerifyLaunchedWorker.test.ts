import { describe, it, expect, vi } from 'vitest';
import { workerRunningInSnapshot, verifyLaunchedWorker, VERIFY_FIRST_WAIT_MS, VERIFY_SECOND_WAIT_MS } from './VerifyLaunchedWorker';
import type { ProcessEntry } from '../../shared/os/processList';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { ServerConfig } from '../servers/Server';

const UUID = '14b46fcb-1234-4def-8abc-000000000001';

function entry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return { pid: 100, ppid: 1, startMs: 1000, executable: null, commandLine: '', rssBytes: null, ...overrides } as ProcessEntry;
}

function claudeProcess(pid: number, ppid: number): ProcessEntry {
  return entry({ pid, ppid, commandLine: `claude --resume ${UUID} --dangerously-skip-permissions` });
}

const server = { name: 'local-server', type: 'local' } as unknown as ServerConfig;

describe('workerRunningInSnapshot', () => {
  it('finds the worker among the pane pid and its descendants', () => {
    const entries = [entry({ pid: 10, ppid: 1 }), claudeProcess(11, 10)];
    expect(workerRunningInSnapshot(entries, 10)).toBe(true);
  });

  it('does not take an unrelated process for the worker', () => {
    const entries = [entry({ pid: 10, ppid: 1, commandLine: 'bash' }), entry({ pid: 12, ppid: 9, commandLine: `claude --resume ${UUID}` })];
    expect(workerRunningInSnapshot(entries, 10)).toBe(false);
  });

  it('returns null when the pane pid cannot be known (no false "not running")', () => {
    expect(workerRunningInSnapshot([], null)).toBeNull();
  });
});

describe('verifyLaunchedWorker', () => {
  const noWait = () => Promise.resolve();

  function makeIo(over: { panePid?: number | null; panePidError?: Error; entries?: ProcessEntry[]; listError?: Error; capture?: string } = {}) {
    const driver = {
      panePidByHandle: vi.fn(async () => {
        if (over.panePidError) throw over.panePidError;
        return over.panePid === undefined ? 10 : over.panePid;
      }),
      captureScreen: vi.fn(async () => ({ stdout: over.capture ?? '', stderr: '', code: 0 })),
    } as unknown as IMuxClient;
    return {
      driver,
      server,
      handle: 'pane-1' as never,
      listProcesses: vi.fn(async () => {
        if (over.listError) throw over.listError;
        return over.entries ?? [entry({ pid: 10, ppid: 1 })];
      }),
      sleep: noWait,
    };
  }

  it('reports running on the immediate first probe, without any wait', async () => {
    const io = makeIo({ entries: [entry({ pid: 10, ppid: 1 }), claudeProcess(11, 10)] });
    const waits: number[] = [];
    const result = await verifyLaunchedWorker({ ...io, sleep: async (ms) => { waits.push(ms); } });
    expect(result).toEqual({ running: true, screenTail: null, unverifiableReason: '' });
    expect(io.listProcesses).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('reports running on the second probe when the worker is slow to appear', async () => {
    let call = 0;
    const io = makeIo();
    io.listProcesses = vi.fn(async () => {
      call += 1;
      return call === 1 ? [entry({ pid: 10, ppid: 1 })] : [entry({ pid: 10, ppid: 1 }), claudeProcess(11, 10)];
    });
    const result = await verifyLaunchedWorker(io);
    expect(result.running).toBe(true);
    expect(io.listProcesses).toHaveBeenCalledTimes(2);
    expect(io.listProcesses).toHaveBeenCalledAfter(io.driver.panePidByHandle as never);
  });

  it('waits the documented constants between the probes', async () => {
    const io = makeIo();
    const waits: number[] = [];
    const result = await verifyLaunchedWorker({ ...io, sleep: async (ms) => { waits.push(ms); } });
    expect(result.running).toBe(false);
    expect(waits).toEqual([VERIFY_FIRST_WAIT_MS, VERIFY_SECOND_WAIT_MS]);
    expect(io.listProcesses).toHaveBeenCalledTimes(3);
  });

  it('reports not running with the pane screen tail when the CLI refused the launch', async () => {
    const refusal = 'That session is running in the background (14b46fcb). Run `claude attach 14b46fcb` to open it.';
    const io = makeIo({ capture: `~ ${refusal}` });
    const result = await verifyLaunchedWorker(io);
    expect(result).toEqual({ running: false, screenTail: `~ ${refusal}`, unverifiableReason: '' });
    // The tail is the LAST lines: captureScreen's start counts from the bottom (negative), like SCREEN_CAPTURE_LINES.
    expect(io.driver.captureScreen).toHaveBeenCalledWith(server, 'pane-1', -10);
  });

  it('reports the pane screen as null when it cannot be captured', async () => {
    const driver = {
      panePidByHandle: vi.fn(async () => 10),
      captureScreen: vi.fn(async () => { throw new Error('capture failed'); }),
    } as unknown as IMuxClient;
    const result = await verifyLaunchedWorker({ driver, server, handle: 'pane-1' as never, listProcesses: async () => [entry({ pid: 10, ppid: 1 })], sleep: noWait });
    expect(result.running).toBe(false);
    expect(result.screenTail).toBeNull();
  });

  it('treats an unreadable process list as unverifiable, never as a failed launch', async () => {
    const io = makeIo({ listError: new Error('ps failed') });
    const result = await verifyLaunchedWorker(io);
    expect(result).toEqual({ running: false, screenTail: null, unverifiableReason: expect.stringContaining('ps failed') });
  });

  it('treats a pane with no pid (window gone) as unverifiable', async () => {
    const io = makeIo({ panePid: null });
    const result = await verifyLaunchedWorker(io);
    expect(result.unverifiableReason).toContain('no pid');
  });

  it('keeps the two waits at their documented constants', () => {
    expect(VERIFY_FIRST_WAIT_MS).toBe(3_000);
    expect(VERIFY_SECOND_WAIT_MS).toBe(3_000);
  });
});
