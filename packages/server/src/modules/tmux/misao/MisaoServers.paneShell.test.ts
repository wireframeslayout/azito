import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../servers/Server';
import { AgentHostOutdatedError } from '../../servers/transport/agentHostProtocol';
import type { MisaoMuxClientOptions } from './MisaoMuxClient';

const captured: MisaoMuxClientOptions[] = [];

vi.mock('./MisaoConnection', () => ({
  MisaoConnection: class {
    start = async (): Promise<void> => undefined;
    close(): void {}
  },
  connectDedicatedMisaoClient: vi.fn(),
}));

vi.mock('./MisaoMuxClient', () => ({
  MisaoMuxClient: class {
    constructor(_connection: unknown, options: MisaoMuxClientOptions) {
      captured.push(options);
    }
    installChangeHooks = async (): Promise<void> => undefined;
    uninstallChangeHooks = async (): Promise<void> => undefined;
  },
}));

import { MisaoServers } from './MisaoServers';

const agent = (name: string, hostProfile: ServerConfig['hostProfile'] = null): ServerConfig => (
  { name, type: 'agent', host: 'h', hostProfile, agentPort: 3002, agentToken: 't', defaultMux: 'tmux', isolationIntent: false } as unknown as ServerConfig
);

function build(hostInfo: (server: ServerConfig) => Promise<{ platform: string; arch: string; shell: string | null }>) {
  const log = { warn: vi.fn() };
  const servers = new MisaoServers({
    sdk: {} as never,
    shell: '/bin/hubsh',
    hubEnv: { publicUrl: 'http://hub', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' },
    onChange: vi.fn(),
    log,
    local: { connection: {} as never, driver: {} as never },
    agent: {
      target: () => ({ connect: vi.fn() }) as never,
      status: async () => ({ socketPresent: true }),
      hostInfo,
      latest: (name) => agent(name),
    },
  });
  return { servers, log };
}

describe('MisaoServers pane shell per node', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("starts an agent node's panes with the shell the agent reports, not the hub's", async () => {
    const { servers } = build(async () => ({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' }));
    servers.ensureAgentNode(agent('a1'));
    expect(await captured[0].paneShell()).toEqual({ shell: '/bin/zsh', commandArgs: ['-lc'] });
  });

  it('gives each agent node the shell of its own host', async () => {
    const shells: Record<string, string> = { a1: '/bin/zsh', a2: '/usr/bin/fish' };
    const { servers } = build(async (server) => ({ platform: 'linux', arch: 'x64', shell: shells[server.name] }));
    servers.ensureAgentNode(agent('a1'));
    servers.ensureAgentNode(agent('a2'));
    expect((await captured[0].paneShell()).shell).toBe('/bin/zsh');
    expect((await captured[1].paneShell()).shell).toBe('/usr/bin/fish');
  });

  it('keeps an agent that cannot report its host on the hub shell, as before', async () => {
    const { servers, log } = build(async () => { throw new AgentHostOutdatedError('a1'); });
    servers.ensureAgentNode(agent('a1'));
    expect(await captured[0].paneShell()).toEqual({ shell: '/bin/hubsh', commandArgs: ['-lc'] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('agent_outdated'));
  });

  it('fails for an agent with no default shell and for a Windows agent', async () => {
    const noShell = build(async () => ({ platform: 'linux', arch: 'x64', shell: null }));
    noShell.servers.ensureAgentNode(agent('a1'));
    await expect(captured[0].paneShell()).rejects.toThrow(/no default shell/);

    const windows = build(async () => ({ platform: 'win32', arch: 'x64', shell: 'cmd.exe' }));
    windows.servers.ensureAgentNode(agent('w1', { platform: 'win32', arch: 'x64' }));
    await expect(captured[1].paneShell()).rejects.toMatchObject({ code: 'unsupported_os' });
  });
});
