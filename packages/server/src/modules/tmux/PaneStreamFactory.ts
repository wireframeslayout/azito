import { asPaneHandle, type PaneHandle } from '@azito/shared';
import type { IPaneStream, IPaneStreamFactory } from './PaneStream';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { PaneOutputStream } from './PaneOutputStream';
import type { MisaoLineSource } from './misao/MisaoConnection';
import { MisaoPaneStream } from './misao/MisaoPaneStream';

type StreamServer = Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime' | 'defaultMux'>;

export class PaneStreamFactory implements IPaneStreamFactory {
  /** `misaoLines` reads the misao daemon's line stream for local misao servers. */
  constructor(
    private transportFactory: TransportFactory,
    private misaoLines: MisaoLineSource,
  ) {}

  create(handle: PaneHandle | string, server: StreamServer, pane?: PaneHandle): IPaneStream {
    if (server.type === 'local' && server.defaultMux === 'misao') {
      // A pane's output comes from the daemon's line stream; without a pane the stream is a plain file the agent writes (signal file).
      return pane ? new MisaoPaneStream(pane, this.misaoLines) : new PaneOutputStream(handle);
    }

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
      defaultMux: server.defaultMux,
    }).createPaneStream(paneHandle);
  }
}
