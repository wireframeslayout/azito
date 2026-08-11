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

describe('TmuxClient.isPaneInMode', () => {
  it('returns true when tmux reports pane_in_mode=1 (copy-mode)', async () => {
    const client = makeClient(async () => ({ stdout: '1\n', stderr: '', code: 0 }));
    await expect(client.isPaneInMode(srv, '%1')).resolves.toBe(true);
  });

  it('returns false when tmux reports pane_in_mode=0', async () => {
    const client = makeClient(async () => ({ stdout: '0\n', stderr: '', code: 0 }));
    await expect(client.isPaneInMode(srv, '%1')).resolves.toBe(false);
  });

  it('returns false when the command fails (unknown pane treated as not in-mode)', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: "can't find pane", code: 1 }));
    await expect(client.isPaneInMode(srv, '%1')).resolves.toBe(false);
  });

  it('returns false when the command throws (local transport)', async () => {
    const client = makeClient(async () => { throw new Error("can't find pane: %1"); });
    await expect(client.isPaneInMode(srv, '%1')).resolves.toBe(false);
  });
});

describe('TmuxClient.cancelPaneMode', () => {
  it('sends `send-keys -X -t <target> cancel`', async () => {
    const execTmux = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const factory = { getTransport: () => ({ execTmux }) } as unknown as TransportFactory;
    const client = new TmuxClient(factory, 'http://localhost:3001', '', 'http://127.0.0.1:3001');
    await client.cancelPaneMode(srv, '%1');
    expect(execTmux).toHaveBeenCalledWith(['send-keys', '-X', '-t', '%1', 'cancel']);
  });
});
