import type { ServerConfig } from '../../servers/Server';
import type { MuxDriverAvailability, MuxProbeTarget } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import type { HubPaneEnvConfig } from '../hubPaneEnv';
import type { MisaoSocketStatus } from '../../servers/transport/agentMisaoSocket';
import { MisaoConnection, connectDedicatedMisaoClient, type MisaoSdk, type MisaoTarget } from './MisaoConnection';
import { MisaoMuxClient } from './MisaoMuxClient';

/** One misao daemon as the hub talks to it: its connection and the driver on top of it. */
export interface MisaoNode {
  connection: MisaoConnection;
  driver: MisaoMuxClient;
}

/** What runs beside a node for as long as it lives (activity detection, listing refreshes); created by the composition root. */
export interface MisaoNodeObserver {
  start(): void;
  stop(): void;
}

export interface MisaoServersDeps {
  sdk: MisaoSdk;
  shell: string;
  hubEnv: HubPaneEnvConfig;
  onChange: (serverName: string) => void;
  log: { warn(message: string): void };
  /** The hub's own daemon connection, shared by every local server. */
  local: MisaoNode;
  /** How the SDK reaches the misao of an agent server (a relay over the agent's WebSocket), and what the agent sees on its disk. */
  agent: {
    target: (server: ServerConfig) => MisaoTarget;
    status: (server: ServerConfig) => Promise<Pick<MisaoSocketStatus, 'socketPresent'>>;
  };
}

/** Creates the observers of an agent server's node (they start with the node and stop with it). */
export type MisaoObserverFactory = (server: ServerConfig, node: MisaoNode) => MisaoNodeObserver;

interface AgentNode extends MisaoNode {
  server: ServerConfig;
  observer: MisaoNodeObserver | undefined;
}

type NodeServer = Pick<ServerConfig, 'name' | 'type'>;

/**
 * The misao daemons the hub talks to, one per host: the local daemon (shared by every local server, as before) and
 * one per agent server that has misao, created on demand and dropped when the server changes or goes away.
 * An agent server "hosts" misao from the moment its node exists, which is what keeps a never-set-up agent out of
 * listings (see `MuxDriverHosted`): nodes are created at startup for servers that use misao, after an install, and
 * when the agent reports a daemon socket.
 */
export class MisaoServers {
  private readonly agentNodes = new Map<string, AgentNode>();
  private observerFactory: MisaoObserverFactory | undefined;

  constructor(private readonly deps: MisaoServersDeps) {}

  /** Set once by the composition root, which owns what observes a node (activity detection needs the window table). Applies to nodes created afterwards. */
  setObserverFactory(factory: MisaoObserverFactory): void {
    this.observerFactory = factory;
  }

  get local(): MisaoNode {
    return this.deps.local;
  }

  /** The agent node of a server name, when it has one. */
  agentNode(serverName: string): MisaoNode | undefined {
    return this.agentNodes.get(serverName);
  }

  /** Whether the server has a misao to talk to: every local server, an agent server once its node exists. */
  hosts(server: MuxProbeTarget): boolean {
    if (server.type === undefined || server.type === 'local') return true;
    return server.name !== undefined && this.agentNodes.has(server.name);
  }

  /** The node of a server. Throws `not_installed` for an agent server that has none: reading never creates one. */
  nodeFor(server: NodeServer): MisaoNode {
    if (server.type === 'local') return this.deps.local;
    const node = this.agentNodes.get(server.name);
    if (!node) throw new MuxDriverUnavailableError('misao', 'not_installed');
    return node;
  }

  availability(server: MuxProbeTarget): MuxDriverAvailability {
    if (server.type === undefined || server.type === 'local') return this.deps.local.connection.availability();
    const node = server.name === undefined ? undefined : this.agentNodes.get(server.name);
    return node ? node.connection.availability() : { available: false, reason: 'not_installed' };
  }

  /**
   * The node of an agent server, created (and its connection started, in the background) when it does not exist yet.
   * Idempotent. The connection retries on its own until the daemon answers, so a node made before the daemon is up is fine.
   */
  ensureAgentNode(server: ServerConfig): MisaoNode {
    const existing = this.agentNodes.get(server.name);
    if (existing) return existing;
    const { sdk, shell, hubEnv, onChange, log } = this.deps;
    const target = this.deps.agent.target(server);
    const connection = new MisaoConnection({ ...target, sdk, log });
    const driver = new MisaoMuxClient(connection, { shell, onChange, log, hubEnv, connectAttachClient: () => connectDedicatedMisaoClient(sdk, target) });
    const node: AgentNode = { connection, driver, server, observer: undefined };
    this.agentNodes.set(server.name, node);
    void connection.start().catch((err: unknown) => log.warn(`[misao] could not start the connection to ${server.name}: ${err instanceof Error ? err.message : String(err)}`));
    driver.installChangeHooks(server).catch((err: unknown) => {
      log.warn(`Change events for ${server.name} are not active yet (will start when its misao daemon is reachable): ${err}`);
    });
    node.observer = this.observerFactory?.(server, node);
    node.observer?.start();
    return node;
  }

  /**
   * Gives an agent server a node when its agent reports a misao socket (a daemon set up by hand or by an earlier install),
   * and says whether it has one. Rejects when the agent cannot be asked; the caller decides whether that matters.
   */
  async discoverAgentNode(server: ServerConfig): Promise<boolean> {
    if (this.agentNodes.has(server.name)) return true;
    const { socketPresent } = await this.deps.agent.status(server);
    if (!socketPresent) return false;
    this.ensureAgentNode(server);
    return true;
  }

  /** Drops an agent server's node (server edited or deleted, or its agent gone): its connection and observers end. */
  discardAgentNode(server: Pick<ServerConfig, 'name'>): void {
    const node = this.agentNodes.get(server.name);
    if (!node) return;
    this.agentNodes.delete(server.name);
    node.observer?.stop();
    node.driver.uninstallChangeHooks(node.server).catch(() => undefined);
    node.connection.close();
  }

  /** Closes every agent node (hub shutdown). The local connection is the caller's. */
  closeAgentNodes(): void {
    for (const name of [...this.agentNodes.keys()]) this.discardAgentNode({ name });
  }
}
