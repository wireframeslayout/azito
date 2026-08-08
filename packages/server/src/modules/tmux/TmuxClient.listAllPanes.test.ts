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

describe('TmuxClient.listAllPanes', () => {
  it('parses pane rows into TmuxPaneInfo', async () => {
    const client = makeClient(async () => ({
      stdout: '%1|||main|||w1|||/home/user/proj|||claude\n%2|||main|||w2|||/home/user/other|||bash\n',
      stderr: '',
      code: 0,
    }));
    await expect(client.listAllPanes(srv)).resolves.toEqual([
      { paneId: '%1', sessionName: 'main', windowName: 'w1', currentPath: '/home/user/proj', currentCommand: 'claude' },
      { paneId: '%2', sessionName: 'main', windowName: 'w2', currentPath: '/home/user/other', currentCommand: 'bash' },
    ]);
  });

  it('excludes _azito_-prefixed linked sessions', async () => {
    const client = makeClient(async () => ({
      stdout: '%1|||main|||w1|||/home/user/proj|||claude\n%2|||_azito_abc123|||w1|||/home/user/proj|||claude\n',
      stderr: '',
      code: 0,
    }));
    const panes = await client.listAllPanes(srv);
    expect(panes).toHaveLength(1);
    expect(panes[0].sessionName).toBe('main');
  });

  it('returns an empty list when no tmux server is running', async () => {
    const client = makeClient(async () => { throw new Error('no server running on ...'); });
    await expect(client.listAllPanes(srv)).resolves.toEqual([]);
  });

  it('rethrows other errors', async () => {
    const client = makeClient(async () => { throw new Error('some other tmux failure'); });
    await expect(client.listAllPanes(srv)).rejects.toThrow('some other tmux failure');
  });
});
