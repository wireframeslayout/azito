import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { PaneHandle } from '@azito/shared';

const srv: ServerConfig = { name: 'agent-srv', type: 'agent' } as ServerConfig;

function makeClient(execMux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  const factory = {
    getTransport: () => ({ execMux: vi.fn(execMux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, '', '', '', 'wh-tok');
}

function paneLine(sessionName: string): string {
  return [sessionName, '1', '0', '0', '0', 'win', '1', '0', '0', 'bash', '80', '24', '1', '1234', ''].join('|||');
}

// Issue #29 review, Critical finding 1: the isolation gate (servers/routes.ts)
// must use this security-specific method instead of the display-oriented
// listSessions(), because listSessions() (a) ignores the transport's exit
// code — so an agent-type server's connection/permission failure that still
// HTTP 200s with empty stdout reads as "no sessions" (fail open) — and
// (b) hides `_azito_` linked sessions, which can still carry a live,
// credential-bearing pane after the original session they link to is gone.
describe('TmuxClient.listSessionsForSecurityGate', () => {
  it('returns parsed sessions on a clean code-0 result, including _azito_ linked sessions', async () => {
    const client = makeClient(async () => ({
      stdout: [paneLine('normal'), paneLine('_azito_linked_1')].join('\n'),
      stderr: '',
      code: 0,
    }));
    const result = await client.listSessionsForSecurityGate(srv);
    expect(result.map((s) => s.name).sort()).toEqual(['_azito_linked_1', 'normal']);
  });

  it('returns [] when the transport throws "no server running" (local: socket exists, server process gone)', async () => {
    const client = makeClient(async () => {
      throw new Error('no server running on /tmp/tmux-1000/default');
    });
    const result = await client.listSessionsForSecurityGate(srv);
    expect(result).toEqual([]);
  });

  it('returns [] when the transport throws "error connecting to ... (No such file or directory)" (local: socket never existed)', async () => {
    const client = makeClient(async () => {
      throw new Error('error connecting to /tmp/tmux-1000/default (No such file or directory)');
    });
    const result = await client.listSessionsForSecurityGate(srv);
    expect(result).toEqual([]);
  });

  it('returns [] on a non-zero code with "no server running" in stderr (agent transport shape)', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: 'no server running on /tmp/tmux-1000/default', code: 1 }));
    const result = await client.listSessionsForSecurityGate(srv);
    expect(result).toEqual([]);
  });

  it('throws on a non-zero code with an unrecognized message (agent transport: cannot verify, must fail closed)', async () => {
    const client = makeClient(async () => ({ stdout: '', stderr: 'permission denied', code: 1 }));
    await expect(client.listSessionsForSecurityGate(srv)).rejects.toThrow(/permission denied/);
  });

  it('throws on an unrelated thrown error (e.g. unreachable agent server) instead of returning []', async () => {
    const client = makeClient(async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
    });
    await expect(client.listSessionsForSecurityGate(srv)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('session listing pane fields', () => {
  it('reads the pane handle and keeps a title that contains the field separator', async () => {
    const line = ['s', '1', '0', '0', '0', 'win', '1', '0', '1', 'bash', '80', '24', '1', '1234', '%7', 'a|||%9|||b'].join('|||');
    const client = makeClient(async () => ({ stdout: line, stderr: '', code: 0 }));
    const [session] = await client.listSessionsForSecurityGate(srv);
    expect(session.windows[0].panes[0]).toMatchObject({ handle: '%7', title: 'a|||%9|||b', pid: 1234 });
  });
});

describe('TmuxClient.locatePane', () => {
  const handle = '%7' as PaneHandle;
  const found = ['%7', 's', 'win', '1', 's'].join('\t');

  it('finds the pane and reports its window', async () => {
    const result = await makeClient(async () => ({ stdout: `${found}\n`, stderr: '', code: 0 })).locatePane(srv, handle);
    expect(result).toEqual({ status: 'found', ref: { kind: 'tmux', workspace: 's', window: 'win' }, ordinal: 1 });
  });

  it('is absent when the listing does not contain the pane', async () => {
    const result = await makeClient(async () => ({ stdout: '%1\ts\twin\t1\ts\n', stderr: '', code: 0 })).locatePane(srv, handle);
    expect(result).toEqual({ status: 'absent' });
  });

  it.each([
    ['no server running on /tmp/tmux-1000/default'],
    ['error connecting to /tmp/tmux-1000/default (No such file or directory)'],
  ])('is absent when the transport rejects with "%s" (local transport)', async (message) => {
    const result = await makeClient(async () => { throw new Error(message); }).locatePane(srv, handle);
    expect(result).toEqual({ status: 'absent' });
  });

  it('is absent when the rejection carries the wording on stderr', async () => {
    const result = await makeClient(async () => { throw Object.assign(new Error('Command failed'), { stderr: 'no server running on /x' }); }).locatePane(srv, handle);
    expect(result).toEqual({ status: 'absent' });
  });

  it('is unknown when the transport fails for any other reason', async () => {
    const result = await makeClient(async () => { throw new Error('ssh: connection refused'); }).locatePane(srv, handle);
    expect(result).toEqual({ status: 'unknown' });
  });

  it('is absent on a non-zero ExecResult saying there is no server (agent transport)', async () => {
    const result = await makeClient(async () => ({ stdout: '', stderr: 'no server running on /x', code: 1 })).locatePane(srv, handle);
    expect(result).toEqual({ status: 'absent' });
  });

  it('is unknown on any other non-zero ExecResult (agent transport)', async () => {
    const result = await makeClient(async () => ({ stdout: '', stderr: 'permission denied', code: 1 })).locatePane(srv, handle);
    expect(result).toEqual({ status: 'unknown' });
  });
});
