import { describe, expect, it } from 'vitest';
import { TmuxClient } from './TmuxClient';
import { resolveKillOutcome } from './killOutcome';
import { execResultError } from '../windows/windowPaneOps';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const server = { name: 'agent', type: 'agent' } as ServerConfig;
function client(stderr: string): TmuxClient {
  const factory = { getTransport: () => ({ execMux: async () => ({ code: 1, stdout: '', stderr }) }) } as unknown as TransportFactory;
  return new TmuxClient(factory, '', '', '', '', '');
}

describe('agent tmux error classification', () => {
  it.each([
    ['error connecting to /tmp/tmux/default (No such file or directory)', 404],
    ['no such session: missing', 404],
    ["can't find pane: %1", 500],
    ['pane not found: %1', 404],
  ])('preserves the HTTP status for %s', async (stderr, status) => {
    const result = await client(stderr).renameWindow(server, 'main:1', 'new');
    expect(execResultError(result)?.status).toBe(status);
  });
  it('does not treat a missing socket as confirmed absence for kill or liveness', async () => {
    const tmux = client('error connecting to /tmp/tmux/default (No such file or directory)');
    const kill = await resolveKillOutcome(tmux.killSession(server, 'missing'));
    expect(kill.success).toBe(false);
    expect(kill.alreadyGone).toBe(false);
    expect(await tmux.checkPaneLiveness(server, 'missing:1')).toEqual({ alive: false, verified: false });
  });
});
