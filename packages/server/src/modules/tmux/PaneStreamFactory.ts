import type { IPaneStream, IPaneStreamFactory } from './PaneStream';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

export class PaneStreamFactory implements IPaneStreamFactory {
  constructor(private transportFactory: TransportFactory) {}

  create(paneId: string, server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IPaneStream {
    if (server.type === 'agent') {
      return this.transportFactory.getTransport(server).createPaneStream(paneId);
    }
    return this.transportFactory.getTransport({
      name: server.name,
      type: 'local',
      host: null,
      agentPort: null,
      agentToken: null,
      muxRuntime: server.muxRuntime,
    }).createPaneStream(paneId);
  }
}
