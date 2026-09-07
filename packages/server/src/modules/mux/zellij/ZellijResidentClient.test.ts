import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSpawn = vi.fn();
const mockOnData = vi.fn();
const mockOnExit = vi.fn();
const mockKill = vi.fn();
const mockExecFile = vi.fn();

vi.mock('node-pty', () => ({
  spawn: (...args: unknown[]) => {
    mockSpawn(...args);
    return {
      onData: mockOnData,
      onExit: mockOnExit,
      kill: mockKill,
    };
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import { ZellijResidentClient } from './ZellijResidentClient';

describe('ZellijResidentClient', () => {
  let client: ZellijResidentClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, 'azito [Created 1s ago] \n');
    });
    client = new ZellijResidentClient({ zellijBin: '/usr/bin/zellij' });
  });

  afterEach(() => {
    client.detachAll();
  });

  it('spawns a pty process on ensureAttached', async () => {
    await client.ensureAttached('azito');

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/zellij',
      ['attach', 'azito'],
      expect.objectContaining({ cols: 200, rows: 50, name: 'xterm-256color' }),
    );
    expect(mockOnData).toHaveBeenCalled();
    expect(mockOnExit).toHaveBeenCalled();
    expect(client.isAttached('azito')).toBe(true);
  });

  it('is idempotent — second call does not spawn again', async () => {
    await client.ensureAttached('azito');
    await client.ensureAttached('azito');

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('detach kills the process and removes from map', async () => {
    await client.ensureAttached('azito');
    expect(client.isAttached('azito')).toBe(true);

    client.detach('azito');
    expect(client.isAttached('azito')).toBe(false);
    expect(mockKill).toHaveBeenCalled();
  });

  it('detach on unknown session is a no-op', () => {
    client.detach('nonexistent');
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('detachAll kills all processes', async () => {
    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, 'session-a [Created 1s ago] \nsession-b [Created 1s ago] \n');
    });
    await client.ensureAttached('session-a');
    await client.ensureAttached('session-b');

    client.detachAll();
    expect(client.isAttached('session-a')).toBe(false);
    expect(client.isAttached('session-b')).toBe(false);
    expect(mockKill).toHaveBeenCalledTimes(2);
  });

  it('onExit removes the entry from the map', async () => {
    await client.ensureAttached('azito');
    expect(client.isAttached('azito')).toBe(true);

    const exitCallback = mockOnExit.mock.calls[0][0] as () => void;
    exitCallback();

    expect(client.isAttached('azito')).toBe(false);
  });

  it('respawns after process exit on next ensureAttached', async () => {
    await client.ensureAttached('azito');
    const exitCallback = mockOnExit.mock.calls[0][0] as () => void;
    exitCallback();
    expect(client.isAttached('azito')).toBe(false);

    await client.ensureAttached('azito');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(client.isAttached('azito')).toBe(true);
  });

  it('uses custom cols and rows', async () => {
    const custom = new ZellijResidentClient({ zellijBin: '/usr/bin/zellij', cols: 120, rows: 40 });
    await custom.ensureAttached('azito');

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/zellij',
      ['attach', 'azito'],
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
    custom.detachAll();
  });
});
