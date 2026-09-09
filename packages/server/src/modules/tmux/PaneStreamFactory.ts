import { asPaneHandle, type PaneHandle, type MuxRuntime, muxKindForRuntime } from '@azito/shared';
import type { IPaneStream, IPaneStreamFactory } from './PaneStream';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { HerdrPaneStream } from '../mux/herdr/HerdrPaneStream';

export function isHerdrPaneId(handle: string): boolean {
  return /^w\d+:p\d+$/.test(handle);
}

export class PaneStreamFactory implements IPaneStreamFactory {
  constructor(private transportFactory: TransportFactory) {}

  create(handle: PaneHandle | string, server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IPaneStream {
    const paneHandle = typeof handle === 'string' ? asPaneHandle(handle) : handle;

    // Only a real herdr pane id (`w<N>:p<N>`) is served by HerdrPaneStream. Callers also
    // create file-backed streams on the same server (the `<taskId>-sig` completion-signal
    // tail in WorkerWaiter); routing those through pane.read made herdr answer
    // `pane_not_found`, and the unhandled 'error' took the whole hub down (rc.15 E2E).
    if (muxKindForRuntime((server.muxRuntime ?? 'system') as MuxRuntime) === 'herdr' && isHerdrPaneId(paneHandle as string)) {
      const transport = this.transportFactory.getTransport(server);
      const rpc = async (method: string, params: unknown) => {
        const result = await transport.execMux({ kind: 'herdr', method, params });
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && 'result' in parsed && !('type' in parsed)) {
          return (parsed.result ?? {}) as Record<string, unknown>;
        }
        return parsed;
      };
      return new HerdrPaneStream(paneHandle as string, rpc);
    }

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
