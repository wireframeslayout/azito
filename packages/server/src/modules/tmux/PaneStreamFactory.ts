import { asPaneHandle, muxKindOfPaneHandle, type PaneHandle } from '@azito/shared';
import type { IPaneStream, IPaneStreamFactory } from './PaneStream';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { PaneOutputStream } from './PaneOutputStream';
import type { MisaoLineSource } from './misao/MisaoConnection';
import { MisaoPaneStream } from './misao/MisaoPaneStream';

type StreamServer = Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>;

export class PaneStreamFactory implements IPaneStreamFactory {
  /** `misaoLines` reads the misao daemon's line stream for misao panes. */
  constructor(
    private transportFactory: TransportFactory,
    private misaoLines: MisaoLineSource,
  ) {}

  create(handle: PaneHandle | string, server: StreamServer, pane?: PaneHandle): IPaneStream {
    // A misao pane's output comes from the daemon's line stream (told by the pane's handle, not by the server's default mux).
    if (pane && muxKindOfPaneHandle(pane) === 'misao') return new MisaoPaneStream(pane, this.misaoLines);

    const paneHandle = typeof handle === 'string' ? asPaneHandle(handle) : handle;

    if (server.type === 'agent') {
      return this.transportFactory.getTransport(server).createPaneStream(paneHandle);
    }
    return this.transportFactory.getTransport({
      name: server.name,
      type: 'local',
      host: null,
      agentPort: null,
      agentToken: null,
      muxRuntime: server.muxRuntime,
    }).createPaneStream(paneHandle);
  }
}
