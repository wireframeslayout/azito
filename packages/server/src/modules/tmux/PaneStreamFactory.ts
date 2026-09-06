import { asPaneHandle, type PaneHandle } from '@azito/shared';
import type { IPaneStream, IPaneStreamFactory } from './PaneStream';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

export class PaneStreamFactory implements IPaneStreamFactory {
  constructor(private transportFactory: TransportFactory) {}

  create(handle: PaneHandle | string, server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IPaneStream {
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
