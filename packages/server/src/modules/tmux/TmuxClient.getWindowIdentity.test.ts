import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;

function makeClient(execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, 'http://localhost:3001', '', 'http://127.0.0.1:3001');
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
