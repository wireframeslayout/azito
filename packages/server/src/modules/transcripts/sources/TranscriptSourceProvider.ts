import type { ServerConfig } from '../../servers/Server';
import type { TranscriptSource } from './TranscriptSource';

/**
 * サーバーごとの会話ログの読み取り口を返す。会話ログはエージェントが動くマシンにあるため、
 * 読み取り先はウィンドウのサーバーで決まる。
 */
export interface TranscriptSourceProvider {
  /** そのサーバーの会話ログを読む TranscriptSource 群。会話ログを読めないサーバー種別（ssh）は null。 */
  forServer(server: Pick<ServerConfig, 'name' | 'type'>): TranscriptSource[] | null;
}

export class HostTranscriptSourceProvider implements TranscriptSourceProvider {
  constructor(private readonly localSources: TranscriptSource[]) {}

  forServer(server: Pick<ServerConfig, 'name' | 'type'>): TranscriptSource[] | null {
    return server.type === 'local' ? this.localSources : null;
  }
}
