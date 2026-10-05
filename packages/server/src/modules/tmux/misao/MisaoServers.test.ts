import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../servers/Server';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { MisaoConnection } from './MisaoConnection';
import { MisaoMuxClient } from './MisaoMuxClient';
import { MisaoServers, type MisaoNodeObserver } from './MisaoServers';
import { MisaoDriverRouter } from './MisaoDriverRouter';

function fakeSdk() {
  const clients: Array<{ target: unknown; close: ReturnType<typeof vi.fn> }> = [];
  class FakeConnectionError extends Error {}
  const sdk = {
    MisaoClient: function MisaoClient(this: unknown, target: unknown) {
      const close = vi.fn();
      clients.push({ target, close });
      return {
        onStateChange: () => {},
        onGap: () => {},
        onEventsRecovered: () => () => {},
        onSubscriptionError: () => {},
        onError: () => {},
        connect: async () => { throw new FakeConnectionError('no daemon in this test'); },
        close,
      };
    },
    MisaoConnectionError: FakeConnectionError,
    MisaoRpcError: class extends Error {},
    MisaoProtocolVersionError: class extends Error {},
    DEFAULT_BACKOFF: { initialDelayMs: 100, maxDelayMs: 5000, factor: 2 },
    computeBackoffDelay: () => 60_000,
  };
  return { sdk: sdk as never, clients };
}

const agent = (name: string) => ({ name, type: 'agent', host: 'h', agentPort: 3002, agentToken: 't', defaultMux: 'tmux', isolationIntent: false }) as unknown as ServerConfig;
const local = { name: 'local', type: 'local', defaultMux: 'tmux', isolationIntent: false } as unknown as ServerConfig;

const targetsSeen: ServerConfig[] = [];
let latestOf: (name: string) => ServerConfig | null = (name) => agent(name);

function setup(status: () => Promise<{ socketPresent: boolean }> = async () => ({ socketPresent: true })) {
  const { sdk, clients } = fakeSdk();
  const log = { warn: vi.fn() };
  const hubEnv = { publicUrl: 'http://hub', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' };
  const localConnection = new MisaoConnection({ socketPath: '/local.sock', sdk, log });
  const localDriver = new MisaoMuxClient(localConnection, { shell: '/bin/bash', onChange: vi.fn(), log, hubEnv, connectAttachClient: async () => { throw new Error('unused'); } });
  const connect = vi.fn(async () => { throw new Error('unused'); });
  const servers = new MisaoServers({
    sdk, shell: '/bin/bash', hubEnv, onChange: vi.fn(), log,
    local: { connection: localConnection, driver: localDriver },
    agent: { target: (srv) => { targetsSeen.push(srv); return { connect }; }, status, latest: (name) => latestOf(name) },
  });
  return { servers, clients, localConnection, localDriver, connect, log };
}

describe('MisaoServers', () => {
  it('hosts misao on every local server and on an agent server only once it has a node', () => {
    const { servers } = setup();
    expect(servers.hosts(local)).toBe(true);
    expect(servers.hosts({})).toBe(true);
    expect(servers.hosts(agent('a1'))).toBe(false);
    servers.ensureAgentNode(agent('a1'));
    expect(servers.hosts(agent('a1'))).toBe(true);
    expect(servers.hosts(agent('a2'))).toBe(false);
    servers.closeAgentNodes();
  });

  it('gives a local server the shared local node and an agent server its own', () => {
    const { servers, localDriver } = setup();
    const node = servers.ensureAgentNode(agent('a1'));
    expect(servers.nodeFor(local).driver).toBe(localDriver);
    expect(servers.nodeFor(agent('a1'))).toBe(node);
    expect(node.driver).not.toBe(localDriver);
    expect(servers.ensureAgentNode(agent('a1'))).toBe(node);
    servers.closeAgentNodes();
  });

  it('reads no node for an agent server that has none: not_installed, and nothing is created', () => {
    const { servers, clients } = setup();
    expect(() => servers.nodeFor(agent('a1'))).toThrow(MuxDriverUnavailableError);
    expect(servers.availability(agent('a1'))).toEqual({ available: false, reason: 'not_installed' });
    expect(servers.availability({ type: 'agent' })).toEqual({ available: false, reason: 'not_installed' });
    expect(clients).toHaveLength(0);
  });

  it('reports the availability of the node of that server only', () => {
    const { servers } = setup();
    servers.ensureAgentNode(agent('a1'));
    expect(servers.availability(agent('a1'))).toEqual({ available: false, reason: 'daemon_unreachable' });
    expect(servers.availability(agent('a2'))).toEqual({ available: false, reason: 'not_installed' });
    servers.closeAgentNodes();
  });

  it('connects an agent node through the target the composition root gave it, and each node through its own', async () => {
    const { servers, clients, connect } = setup();
    servers.ensureAgentNode(agent('a1'));
    servers.ensureAgentNode(agent('a2'));
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    expect(clients.every((c) => (c.target as { connect?: unknown }).connect === connect)).toBe(true);
    servers.closeAgentNodes();
  });

  it('starts the observer with the node and stops it, and closes the connection, when the node is discarded', async () => {
    const { servers, clients } = setup();
    const observer: MisaoNodeObserver = { start: vi.fn(), stop: vi.fn() };
    const factory = vi.fn(() => observer);
    servers.setObserverFactory(factory);
    servers.ensureAgentNode(agent('a1'));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(observer.start).toHaveBeenCalledTimes(1);

    servers.discardAgentNode({ name: 'a1' });
    expect(observer.stop).toHaveBeenCalledTimes(1);
    expect(servers.hosts(agent('a1'))).toBe(false);
    await vi.waitFor(() => expect(clients[0].close).toHaveBeenCalled());
    // Discarding what is not there is not an error.
    servers.discardAgentNode({ name: 'a1' });
    expect(observer.stop).toHaveBeenCalledTimes(1);
  });

  it('discovers the node of an agent that reports a daemon socket, and leaves alone one that does not', async () => {
    const present = setup(async () => ({ socketPresent: true }));
    expect(await present.servers.discoverAgentNode(agent('a1'))).toBe(true);
    expect(present.servers.hosts(agent('a1'))).toBe(true);
    present.servers.closeAgentNodes();

    const absent = setup(async () => ({ socketPresent: false }));
    expect(await absent.servers.discoverAgentNode(agent('a1'))).toBe(false);
    expect(absent.servers.hosts(agent('a1'))).toBe(false);
  });

  it('builds the node from the server as stored after the agent answered, not from the one it was asked with', async () => {
    const { servers } = setup(async () => { latestOf = (name) => ({ ...agent(name), agentToken: 'rotated' }); return { socketPresent: true }; });
    targetsSeen.length = 0;
    expect(await servers.discoverAgentNode(agent('a1'))).toBe(true);
    expect(targetsSeen.map((s) => s.agentToken)).toEqual(['rotated']);
    servers.closeAgentNodes();
    latestOf = (name) => agent(name);
  });

  it('builds no node for a server that was deleted while the agent was being asked', async () => {
    const { servers } = setup(async () => { latestOf = () => null; return { socketPresent: true }; });
    expect(await servers.discoverAgentNode(agent('a1'))).toBe(false);
    expect(servers.hosts(agent('a1'))).toBe(false);
    latestOf = (name) => agent(name);
  });

  it('does not ask the agent again when the node exists, and passes an unreachable agent on to the caller', async () => {
    const status = vi.fn(async () => ({ socketPresent: true }));
    const { servers } = setup(status);
    servers.ensureAgentNode(agent('a1'));
    expect(await servers.discoverAgentNode(agent('a1'))).toBe(true);
    expect(status).not.toHaveBeenCalled();
    servers.closeAgentNodes();

    const down = setup(async () => { throw new Error('agent unreachable'); });
    await expect(down.servers.discoverAgentNode(agent('a2'))).rejects.toThrow('agent unreachable');
  });
});

describe('MisaoDriverRouter', () => {
  it('sends a call to the driver of the server it is for', async () => {
    const { servers, localDriver } = setup();
    const node = servers.ensureAgentNode(agent('a1'));
    const router = new MisaoDriverRouter(servers);
    const localList = vi.spyOn(localDriver, 'listAllPanes').mockResolvedValue([]);
    const agentList = vi.spyOn(node.driver, 'listAllPanes').mockResolvedValue([]);

    await router.listAllPanes(local);
    expect(localList).toHaveBeenCalledWith(local);
    expect(agentList).not.toHaveBeenCalled();

    await router.listAllPanes(agent('a1'));
    expect(agentList).toHaveBeenCalledTimes(1);
    servers.closeAgentNodes();
  });

  it('fails with not_installed for an agent server without misao, and has nothing to undo for its change hooks', async () => {
    const { servers } = setup();
    const router = new MisaoDriverRouter(servers);
    await expect(router.listAllPanes(agent('a1'))).rejects.toMatchObject({ reason: 'not_installed' });
    await expect(router.uninstallChangeHooks(agent('a1'))).resolves.toBeUndefined();
  });
});
