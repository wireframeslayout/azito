import type { ServerConfig } from '../../servers/Server';
import type { AgentTransport } from '../../servers/transport/AgentTransport';
import { AgentTranscriptSource } from './AgentTranscriptSource';
import type { TranscriptSource } from './TranscriptSource';

export type TranscriptServer = Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>;

/**
 * サーバーごとの会話ログの読み取り口を返す。会話ログはエージェントが動くマシンにあるため、
 * 読み取り先はウィンドウのサーバーで決まる。
 */
export interface TranscriptSourceProvider {
  /**
   * そのサーバーの会話ログを読む TranscriptSource 群。会話ログを読めないサーバー種別（ssh）は null。
   * エージェントサーバーのソースはエージェントに届かないとき（読み取り時に）AgentUnreachableError を投げる。
   */
  forServer(server: TranscriptServer): TranscriptSource[] | null;
}

/** AgentTransport を引く口（TransportFactory.getAgentTransport）。 */
export interface AgentTransportLookup {
  getAgentTransport(server: TranscriptServer): AgentTransport;
}

/**
 * local はハブ自身の会話ログ、agent はエージェント上の会話ログ（エージェントの API 経由。読む agentType は
 * local と同じ）、ssh は読めない。
 *
 * 隔離（isolationIntent）サーバーでも agent と同じく読む。隔離が守るのは「サーバーがオペレーター相当の
 * 資格情報を持たない」「ハブが注入しない」ことで、会話ログの読み取りはハブ → エージェントの既存のトークンで
 * 会話ログ（エージェントが自分で書いたもの）を受け取るだけ。ハブの秘密は送らず、エージェントに新しい権限も
 * 与えない（docs/{ja,en}/isolated-execution.md）。
 */
export class HostTranscriptSourceProvider implements TranscriptSourceProvider {
  private readonly agentSources = new Map<string, { transport: AgentTransport; sources: TranscriptSource[] }>();

  constructor(
    private readonly localSources: TranscriptSource[],
    private readonly transports: AgentTransportLookup,
  ) {}

  forServer(server: TranscriptServer): TranscriptSource[] | null {
    if (server.type === 'local') return this.localSources;
    if (server.type !== 'agent') return null;

    // TransportFactory はトークンや mux runtime が変わると AgentTransport を作り直す。別の transport に
    // なったら、古い transport を握ったソースは捨てる。
    const transport = this.transports.getAgentTransport(server);
    const cached = this.agentSources.get(server.name);
    if (cached && cached.transport === transport) return cached.sources;

    const sources = this.localSources.map((local) => new AgentTranscriptSource(local.agentType, server.name, transport));
    this.agentSources.set(server.name, { transport, sources });
    return sources;
  }
}
