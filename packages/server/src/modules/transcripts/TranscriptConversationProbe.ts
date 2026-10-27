import { ConversationCheckError } from '../agents/ConversationCheckError';
import type { ServerConfig } from '../servers/Server';
import type { ConversationProbe } from '../windows/ConversationProbe';
import type { TranscriptSourceProvider } from './sources/TranscriptSourceProvider';

/** {@link ConversationProbe} over the per-server conversation logs (local: the hub's own, agent: asked through the agent's API). */
export class TranscriptConversationProbe implements ConversationProbe {
  constructor(private readonly sources: TranscriptSourceProvider) {}

  async exists(server: ServerConfig, agentType: string, sessionId: string): Promise<boolean> {
    const source = this.sources.forServer(server)?.find((s) => s.agentType === agentType);
    if (!source) throw new ConversationCheckError(sessionId, `サーバー ${server.name} の会話ログは読めません(unsupported_server)`);
    if (!source.sessionExists) throw new ConversationCheckError(sessionId, `${agentType} の会話ログは存在確認に対応していません`);
    try {
      return await source.sessionExists(sessionId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ConversationCheckError(sessionId, `サーバー ${server.name} の会話ログを確かめられません: ${reason}`);
    }
  }
}
