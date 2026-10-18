import type { MuxRef } from '@azito/shared';
import type { MisaoHandle } from '../modules/tmux/misao/misaoDriver';
import type { MisaoNode, MisaoNodeObserver } from '../modules/tmux/misao/MisaoServers';
import { MisaoPaneStateEvents } from '../modules/tmux/misao/misaoPaneStateEvents';
import { MisaoActivityBridge, type MisaoActivityBridgeDeps } from '../modules/operations/misaoActivityBridge';
import type { ServerConfig } from '../modules/servers/Server';

export interface MisaoObserversDeps {
  resolver: MisaoActivityBridgeDeps['resolver'];
  findWindowByRef: (serverName: string, ref: MuxRef) => { tmuxTarget: string } | undefined;
  monitor: MisaoActivityBridgeDeps['monitor'];
  /** The local servers (they share the hub's own daemon). Read at use time: servers can be added while the hub runs. */
  listLocalServerNames: () => string[];
  /** A daemon connecting or dropping changes what its server lists: drop the cached listing and let clients refetch. */
  refreshListings: (serverName: string) => void;
  log: { warn(message: string): void };
}

/**
 * What watches each misao daemon the hub talks to: the daemon's per-pane agent state (activity detection) and, for an
 * agent server's daemon, its connection state (listings). The local daemon's watchers are returned for the caller to
 * start once that connection is up; an agent server's are made by the factory registered on `misao.servers`, and start
 * and stop with its node.
 */
export function buildMisaoObservers(misao: MisaoHandle, deps: MisaoObserversDeps): { localPaneStates: MisaoPaneStateEvents; handleWindowsChanged: () => void; stopLocal: () => void } {
  const bridgeDeps = (listServerNames: () => string[]): MisaoActivityBridgeDeps => ({
    resolver: deps.resolver,
    findWindowByRef: deps.findWindowByRef,
    monitor: deps.monitor,
    listServerNames,
    log: deps.log,
  });

  const localBridge = new MisaoActivityBridge(bridgeDeps(deps.listLocalServerNames));
  const localPaneStates = new MisaoPaneStateEvents(misao.connection, localBridge, deps.log);
  const agentBridges = new Map<string, MisaoActivityBridge>();

  const refreshLocal = (): void => { for (const name of deps.listLocalServerNames()) deps.refreshListings(name); };
  const offLocal = [misao.connection.onConnected(refreshLocal), misao.connection.onDisconnected(refreshLocal)];

  misao.servers.setObserverFactory((server: ServerConfig, node: MisaoNode): MisaoNodeObserver => {
    const bridge = new MisaoActivityBridge(bridgeDeps(() => [server.name]));
    const paneStates = new MisaoPaneStateEvents(node.connection, bridge, deps.log);
    const refresh = (): void => deps.refreshListings(server.name);
    let off: Array<() => void> = [];
    return {
      start: () => {
        agentBridges.set(server.name, bridge);
        off = [node.connection.onConnected(refresh), node.connection.onDisconnected(refresh)];
        // Rejects while the daemon is unreachable; the subscription is then made when the connection comes up.
        paneStates.start().catch((err: unknown) => {
          deps.log.warn(`Activity events for ${server.name} are not active yet (will start when its misao daemon is reachable): ${err}`);
        });
      },
      stop: () => {
        paneStates.stop();
        for (const unsubscribe of off) unsubscribe();
        off = [];
        bridge.handleDisconnected();
        agentBridges.delete(server.name);
      },
    };
  });

  return {
    localPaneStates,
    handleWindowsChanged: () => {
      localBridge.handleWindowsChanged();
      for (const bridge of agentBridges.values()) bridge.handleWindowsChanged();
    },
    stopLocal: () => {
      localPaneStates.stop();
      for (const unsubscribe of offLocal) unsubscribe();
    },
  };
}
