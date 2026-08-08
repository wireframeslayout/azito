import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;

function makeClient(execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, '', '', '');
}

// Issue #28 third-party review finding (`azito auth doctor`'s drain check):
// `checkPaneExists` collapses every failure into a bare `false`, which makes
// "confirmed gone" and "couldn't check" indistinguishable to a caller —
// exactly the ambiguity that let the doctor report a server it could never
// reach as a clean/green result. `checkPaneLiveness` must tell them apart.
describe('TmuxClient.checkPaneLiveness', () => {
  it('reports alive+verified when the transport resolves with code 0', async () => {
    const client = makeClient(async () => ({ stdout: 'pane', stderr: '', code: 0 }));
    const result = await client.checkPaneLiveness(srv, 'sess:1');
    expect(result).toEqual({ alive: true, verified: true });
  });

  it('reports gone+verified when the transport throws a "can\'t find" error (local: pane genuinely absent)', async () => {
    const client = makeClient(async () => {
      throw new Error("can't find pane: sess:1");
    });
    const result = await client.checkPaneLiveness(srv, 'sess:1');
    expect(result).toEqual({ alive: false, verified: true });
  });

  it('reports gone+verified when the transport resolves with a non-zero code and "no such session" (agent transport shape)', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: 'no such session: sess', code: 1 }));
    const result = await client.checkPaneLiveness(srv, 'sess:1');
    expect(result).toEqual({ alive: false, verified: true });
  });

  it('reports gone+verified on "no server running" (tmux server itself is gone — trivially nothing is alive)', async () => {
    const client = makeClient(async () => {
      throw new Error('no server running on /tmp/tmux-1000/default');
    });
    const result = await client.checkPaneLiveness(srv, 'sess:1');
    expect(result).toEqual({ alive: false, verified: true });
  });

  it('reports unverified (not alive, not confirmed gone) on an unrelated failure — e.g. an unreachable agent server', async () => {
    const client = makeClient(async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
    });
    const result = await client.checkPaneLiveness(srv, 'sess:1');
    expect(result).toEqual({ alive: false, verified: false });
  });

  it('reports unverified on a non-zero code with an unrecognized error message', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: 'server exited unexpectedly', code: 1 }));
    const result = await client.checkPaneLiveness(srv, 'sess:1');
    expect(result).toEqual({ alive: false, verified: false });
  });
});
