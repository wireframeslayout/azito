import { HerdrEventSubscriber, type HerdrEvent, type HerdrSubscription } from '../mux/herdr/HerdrEventSubscriber';
import { HerdrSocketClient, herdrSocketPath } from '../mux/herdr/HerdrSocketClient';
import type { AgentActivityMonitor, MuxAgentStatus } from './AgentActivityMonitor';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { IServerRepository } from '../servers/Server';

/** `session.snapshot` arrives as `{ id, result: { type, snapshot } }` (or, from tests, already unwrapped). */
function unwrapHerdrSnapshot(resp: unknown): unknown {
  const env = (resp && typeof resp === 'object' && 'result' in (resp as Record<string, unknown>)) ? (resp as { result: unknown }).result : resp;
  if (env && typeof env === 'object' && 'snapshot' in (env as Record<string, unknown>)) return (env as { snapshot: unknown }).snapshot;
  return env;
}


const STRUCTURE_EVENTS: HerdrSubscription[] = [
  { type: 'tab.created' },
  { type: 'tab.closed' },
  { type: 'tab.renamed' },
  { type: 'workspace.created' },
  { type: 'workspace.closed' },
  { type: 'workspace.renamed' },
  { type: 'pane.created' },
  { type: 'pane.closed' },
];

const DEFAULT_TAB_NAME = 'main';

interface PaneMapping {
  workspaceLabel: string;
}

const VALID_AGENT_STATUSES = new Set<string>(['working', 'idle', 'blocked', 'done', 'unknown']);

interface PerServerState {
  subscriber: HerdrEventSubscriber;
  paneCache: Map<string, PaneMapping>;
  socketClient: HerdrSocketClient;
}

export class HerdrEventBridge {
  private servers = new Map<string, PerServerState>();

  constructor(
    private agentActivityMonitor: AgentActivityMonitor,
    private notificationBus: NotificationBus,
    private serverRepo: IServerRepository,
  ) {}

  startAll(): void {
    for (const srv of this.serverRepo.findAll()) {
      if (srv.muxRuntime === 'herdr' && srv.type === 'local') {
        this.add(srv.name);
      }
    }
  }

  add(serverName: string): void {
    if (this.servers.has(serverName)) return;
    const server = this.serverRepo.findByName(serverName);
    if (!server || server.muxRuntime !== 'herdr') return;

    if (server.type === 'local') {
      this.addLocal(serverName);
    }
    // Agent servers use AgentEventStream.onMuxEvent — wired in buildServer.ts.
  }

  handleAgentMuxEvent(serverName: string, event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, unknown>;
    if (typeof e.type !== 'string') return;
    this.handleEvent(serverName, e as HerdrEvent, null);
  }

  remove(serverName: string): void {
    const state = this.servers.get(serverName);
    if (!state) return;
    state.subscriber.stop();
    this.servers.delete(serverName);
  }

  stopAll(): void {
    for (const [, state] of this.servers) {
      state.subscriber.stop();
    }
    this.servers.clear();
  }

  private addLocal(serverName: string): void {
    const sessionName = 'azito';
    const sockPath = herdrSocketPath(sessionName);
    const socketClient = new HerdrSocketClient(sessionName);

    const subs: HerdrSubscription[] = [...STRUCTURE_EVENTS];
    const subscriber = new HerdrEventSubscriber(sockPath, subs);
    const paneCache = new Map<string, PaneMapping>();
    const state: PerServerState = { subscriber, paneCache, socketClient };
    this.servers.set(serverName, state);

    subscriber.on('connected', () => {
      void this.rebuildCacheAndSubscribePanes(serverName, state);
    });
    subscriber.on('event', (event: HerdrEvent) => {
      this.handleEvent(serverName, event, state);
    });

    subscriber.start();
  }

  private async rebuildCacheAndSubscribePanes(serverName: string, state: PerServerState): Promise<void> {
    try {
      const resp = await state.socketClient.call('session.snapshot');
      const snapshot = unwrapHerdrSnapshot(resp) as {
        panes: Array<{ pane_id: string; workspace_id: string; tab_id: string }>;
        workspaces: Array<{ workspace_id: string; label: string }>;
        tabs: Array<{ tab_id: string; workspace_id: string; label: string }>;
      };
      state.paneCache.clear();
      const wsLabels = new Map<string, string>();
      for (const ws of snapshot.workspaces) wsLabels.set(ws.workspace_id, ws.label);

      const paneIds: string[] = [];
      for (const pane of snapshot.panes) {
        const workspaceLabel = wsLabels.get(pane.workspace_id);
        if (workspaceLabel) {
          state.paneCache.set(pane.pane_id, { workspaceLabel });
          paneIds.push(pane.pane_id);
        }
      }

      // Subscribe to agent_status for each pane on the persistent event socket
      // (not the one-shot RPC socket — HerdrSocketClient closes after each call).
      if (paneIds.length > 0) {
        state.subscriber.addSubscriptions(paneIds.map(id => ({
          type: 'pane.agent_status_changed',
          pane_id: id,
        })));
      }
    } catch (err) {
      console.error(`[herdr-bridge] Failed to rebuild cache for ${serverName}:`, err instanceof Error ? err.message : err);
    }
  }

  private handleEvent(serverName: string, event: HerdrEvent, state: PerServerState | null): void {
    const { type } = event;

    if (type === 'pane.agent_status_changed') {
      const paneId = event.pane_id as string | undefined;
      const rawStatus = event.agent_status as string | undefined;
      if (!paneId || !rawStatus || !VALID_AGENT_STATUSES.has(rawStatus)) return;

      const target = state ? this.resolveTarget(paneId, state) : this.resolveTargetFromEvent(event);
      if (!target) return;

      this.agentActivityMonitor.recordMuxSignal(serverName, target, rawStatus as MuxAgentStatus);
      return;
    }

    if (type === 'pane.created') {
      if (state) {
        // New pane — add to cache and subscribe to its agent_status.
        const paneId = event.pane_id as string | undefined;
        const wsId = event.workspace_id as string | undefined;
        const tabId = event.tab_id as string | undefined;
        if (paneId && wsId && tabId) {
          void this.addPaneSubscription(serverName, state, paneId, wsId, tabId);
        }
      }
      this.emitSessionsUpdated(serverName);
      return;
    }

    if (type === 'pane.closed') {
      if (state) {
        const paneId = event.pane_id as string | undefined;
        if (paneId) state.paneCache.delete(paneId);
      }
      this.emitSessionsUpdated(serverName);
      return;
    }

    // Structural changes: invalidate cache and notify.
    if (type === 'tab.created' || type === 'tab.closed' || type === 'tab.renamed' ||
        type === 'workspace.created' || type === 'workspace.closed' || type === 'workspace.renamed') {
      if (state) {
        void this.rebuildCacheAndSubscribePanes(serverName, state);
      }
      this.emitSessionsUpdated(serverName);
    }
  }

  private async addPaneSubscription(
    serverName: string,
    state: PerServerState,
    paneId: string,
    wsId: string,
    tabId: string,
  ): Promise<void> {
    try {
      // Resolve labels from a snapshot (the event only carries IDs).
      const resp = await state.socketClient.call('session.snapshot');
      const snapshot = unwrapHerdrSnapshot(resp) as {
        workspaces: Array<{ workspace_id: string; label: string }>;
      };
      const wsLabel = snapshot.workspaces.find(w => w.workspace_id === wsId)?.label;
      if (wsLabel) {
        state.paneCache.set(paneId, { workspaceLabel: wsLabel });
      }

      state.subscriber.addSubscriptions([{
        type: 'pane.agent_status_changed',
        pane_id: paneId,
      }]);
    } catch (err) {
      console.error(`[herdr-bridge] Failed to subscribe pane ${paneId} on ${serverName}:`, err instanceof Error ? err.message : err);
    }
  }

  private resolveTarget(paneId: string, state: PerServerState): string | null {
    const mapping = state.paneCache.get(paneId);
    if (mapping) return `${mapping.workspaceLabel}:${DEFAULT_TAB_NAME}`;
    return null;
  }

  private resolveTargetFromEvent(event: HerdrEvent): string | null {
    // Agent-relayed events carry workspace labels directly.
    const ws = event.workspace_label as string | undefined;
    if (ws) return `${ws}:${DEFAULT_TAB_NAME}`;
    return null;
  }

  private emitSessionsUpdated(serverName: string): void {
    this.notificationBus.emit({
      type: 'sessions:updated',
      payload: { serverName },
    });
  }
}
