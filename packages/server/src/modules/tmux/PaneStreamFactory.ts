import { asPaneHandle, muxKindForRuntime, type PaneHandle } from '@azito/shared';
import type { IPaneStream, IPaneStreamFactory } from './PaneStream';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { PaneOutputStream } from './PaneOutputStream';
import type { MisaoLineSource, MisaoRpc } from './misao/MisaoConnection';
import { MisaoPaneStream } from './misao/MisaoPaneStream';

type StreamServer = Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>;

export class PaneStreamFactory implements IPaneStreamFactory {
  /** `misaoLines` is set only when the misao driver is enabled (AZITO_EXPERIMENTAL_MISAO). */
  constructor(
    private transportFactory: TransportFactory,
    private misaoLines?: MisaoLineSource & MisaoRpc,
  ) {}

  create(handle: PaneHandle | string, server: StreamServer, pane?: PaneHandle): IPaneStream {
    if (this.misaoLines && server.type === 'local' && muxKindForRuntime(server.muxRuntime) === 'misao') {
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
    }).createPaneStream(paneHandle);
  }
}
