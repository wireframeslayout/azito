import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import { MuxWindowAmbiguousError } from './MuxCapabilityError';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;

function makeClient(execMux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  const factory = {
    getTransport: () => ({ execMux: vi.fn(execMux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, 'http://localhost:3001', '', 'http://127.0.0.1:3001', 'wh-tok', '');
}

describe('TmuxClient.getWindowIdentity', () => {
  it('resolves identity for a name-form target', async () => {
    const client = makeClient(async () => ({ stdout: 'azito|9|win--pws3\n', stderr: '', code: 0 }));
    await expect(client.getWindowIdentity(srv, 'azito:win--pws3')).resolves.toEqual({
      sessionName: 'azito', windowIndex: 9, windowName: 'win--pws3',
    });
  });

  it('resolves identity for an index-form target', async () => {
    const client = makeClient(async () => ({ stdout: 'azito|9|win--pws3\n', stderr: '', code: 0 }));
    await expect(client.getWindowIdentity(srv, 'azito:9')).resolves.toEqual({
      sessionName: 'azito', windowIndex: 9, windowName: 'win--pws3',
    });
  });

  it('rejects the active-window fallback when the target window does not match', async () => {
    // display-message answers with the session's active window even for a target
    // whose window part matches nothing — that answer must not be trusted.
    const client = makeClient(async () => ({ stdout: 'azito|9|win--pws3\n', stderr: '', code: 0 }));
    await expect(client.getWindowIdentity(srv, 'azito:no-such-win')).resolves.toBeNull();
  });

  it('returns null when the command fails', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: "can't find window", code: 1 }));
    await expect(client.getWindowIdentity(srv, 'azito:win--pws3')).resolves.toBeNull();
  });

  it('returns null when the command throws (local transport)', async () => {
    const client = makeClient(async () => { throw new Error("can't find window: x"); });
    await expect(client.getWindowIdentity(srv, 'azito:x')).resolves.toBeNull();
  });
});

describe('TmuxClient.getWindowActivity', () => {
  it('resolves activity for a name-form target', async () => {
    const client = makeClient(async () => ({ stdout: '1700000000|9|win--pws3\n', stderr: '', code: 0 }));
    await expect(client.getWindowActivity(srv, 'azito:win--pws3')).resolves.toBe(1700000000);
  });

  it('resolves activity for an index-form target', async () => {
    const client = makeClient(async () => ({ stdout: '1700000000|9|win--pws3\n', stderr: '', code: 0 }));
    await expect(client.getWindowActivity(srv, 'azito:9')).resolves.toBe(1700000000);
  });

  it('rejects the active-window fallback when the target window does not match', async () => {
    // display-message answers with the session's active window's activity even for a
    // target whose window part matches nothing — that answer must not be trusted, or a
    // stale windows-table row would be reported as running via the active window's activity.
    const client = makeClient(async () => ({ stdout: '1700000000|9|win--pws3\n', stderr: '', code: 0 }));
    await expect(client.getWindowActivity(srv, 'azito:no-such-win')).resolves.toBeNull();
  });

  it('returns null when the command fails', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: "can't find window", code: 1 }));
    await expect(client.getWindowActivity(srv, 'azito:win--pws3')).resolves.toBeNull();
  });

  it('returns null when the command throws (local transport)', async () => {
    const client = makeClient(async () => { throw new Error("can't find window: x"); });
    await expect(client.getWindowActivity(srv, 'azito:x')).resolves.toBeNull();
  });

  it('matches a window whose name itself ends in .digits (raw spec, no pane stripping)', async () => {
    // `azito:foo.1` may address a window literally named "foo.1", not window
    // "foo" pane 1 — the raw spec must be tried before pane-stripping.
    const client = makeClient(async () => ({ stdout: '1700000000|4|foo.1\n', stderr: '', code: 0 }));
    await expect(client.getWindowActivity(srv, 'azito:foo.1')).resolves.toBe(1700000000);
  });

  it('rejects a numeric spec that only matches a coincidentally numeric window name', async () => {
    // tmux resolves a fully numeric spec as an index; a window *named* "2" at
    // index 9 must not satisfy the target `azito:2`.
    const client = makeClient(async () => ({ stdout: '1700000000|9|2\n', stderr: '', code: 0 }));
    await expect(client.getWindowActivity(srv, 'azito:2')).resolves.toBeNull();
  });
});

describe('TmuxClient.resolveWindowForRespawn', () => {
  const ref = { kind: 'tmux' as const, workspace: 'azito', window: 'renamed' };

  it('matches the exact name in the exact session and closes by its window id', async () => {
    const exec = vi.fn(async (request: { args: string[] }) => request.args[0] === 'list-windows'
      ? { stdout: '@2\trenamed\n@3\tother\n', stderr: '', code: 0 }
      : { stdout: '', stderr: '', code: 0 });
    const client = new TmuxClient({ getTransport: () => ({ execMux: exec }) } as unknown as TransportFactory, '', '', '', '', '');
    const resolved = await client.resolveWindowForRespawn(srv, ref);
    expect(exec).toHaveBeenCalledWith({ kind: 'tmux', args: ['list-windows', '-t', '=azito', '-F', '#{window_id}\t#{window_name}'] });
    expect(resolved).toEqual({ kind: 'tmux', workspace: 'azito', window: '@2' });
    await client.closeWindow(srv, resolved!);
    expect(exec).toHaveBeenLastCalledWith({ kind: 'tmux', args: ['kill-window', '-t', 'azito:@2'] });
  });

  it('answers null for a missing name or session', async () => {
    const missing = makeClient(async () => ({ stdout: '@3\tother\n', stderr: '', code: 0 }));
    const noSession = makeClient(async () => ({ stdout: '', stderr: "can't find session: azito", code: 1 }));
    await expect(missing.resolveWindowForRespawn(srv, ref)).resolves.toBeNull();
    await expect(noSession.resolveWindowForRespawn(srv, ref)).resolves.toBeNull();
  });

  it.each(["can't find session: azito", 'no server running on /tmp/tmux-1000/default', 'error connecting to /tmp/tmux-1000/default (No such file or directory)'])('recognizes confirmed absence: %s', async (stderr) => {
    await expect(makeClient(async () => ({ stdout: '', stderr, code: 0 })).resolveWindowForRespawn(srv, ref)).resolves.toBeNull();
  });
  it('rejects an SSH success status with unrecognized stderr', async () => {
    await expect(makeClient(async () => ({ stdout: '', stderr: 'permission denied', code: 0 })).resolveWindowForRespawn(srv, ref)).rejects.toThrow('Cannot verify');
  });

  it('refuses a name more than one window carries', async () => {
    const duplicate = makeClient(async () => ({ stdout: '@2\trenamed\n@3\trenamed\n', stderr: '', code: 0 }));
    await expect(duplicate.resolveWindowForRespawn(srv, ref)).rejects.toBeInstanceOf(MuxWindowAmbiguousError);
  });

  it('propagates a failure it cannot read as "gone"', async () => {
    const thrown = makeClient(async () => { throw new Error('connection refused'); });
    const failed = makeClient(async () => ({ stdout: '', stderr: 'permission denied', code: 1 }));
    await expect(thrown.resolveWindowForRespawn(srv, ref)).rejects.toThrow('connection refused');
    await expect(failed.resolveWindowForRespawn(srv, ref)).rejects.toThrow('Cannot verify tmux window');
  });
});
