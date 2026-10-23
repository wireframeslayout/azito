import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

import { runTailscale } from './tailscale';

type Callback = (err: (Error & { code?: string }) | null, stdout?: string) => void;

function missing(): Error & { code: string } {
  return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
}

describe('runTailscale', () => {
  beforeEach(() => { execFileMock.mockReset(); });

  it('uses the one on PATH first', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => cb(null, '100.64.0.1\n'));
    expect(await runTailscale(['ip', '-4'], 1000)).toBe('100.64.0.1\n');
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(['tailscale']);
  });

  it("finds Homebrew's tailscale when PATH (an SSH session on a Mac) does not have it", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], _opts: unknown, cb: Callback) => (
      file === '/opt/homebrew/bin/tailscale' ? cb(null, '100.64.0.2\n') : cb(missing())
    ));
    expect(await runTailscale(['ip', '-4'], 1000)).toBe('100.64.0.2\n');
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(['tailscale', '/opt/homebrew/bin/tailscale']);
  });

  it('tries the Intel Homebrew location last', async () => {
    execFileMock.mockImplementation((file: string, _args: string[], _opts: unknown, cb: Callback) => (
      file === '/usr/local/bin/tailscale' ? cb(null, 'ok') : cb(missing())
    ));
    expect(await runTailscale(['version'], 1000)).toBe('ok');
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']);
  });

  it('does not move on when the CLI was found and failed', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => cb(Object.assign(new Error('not logged in'), { code: '1' })));
    await expect(runTailscale(['ip', '-4'], 1000)).rejects.toThrow('not logged in');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with ENOENT when no location has it', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => cb(missing()));
    await expect(runTailscale(['ip', '-4'], 1000)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});
