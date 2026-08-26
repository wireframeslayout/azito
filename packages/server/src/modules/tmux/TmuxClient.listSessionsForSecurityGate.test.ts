import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'agent-srv', type: 'agent' } as ServerConfig;

function makeClient(execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>): TmuxClient {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, '', '', '');
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
