import type {
  ReadSessionBeforeResult,
  ReadSessionResult,
  SessionSummary,
  SessionTailState,
  TranscriptReader,
  TranscriptSource,
} from './TranscriptSource';

/**
 * 会話ログがハブ自身のマシンにある場合の TranscriptSource。同期の TranscriptReader をそのまま
 * 呼び、非同期の口に合わせるだけ（パース・探索のロジックは reader 側にあり、エージェント上の
 * 読み取りと共有する）。
 */
export class LocalTranscriptSource implements TranscriptSource {
  constructor(private readonly reader: TranscriptReader) {}

  get agentType(): string {
    return this.reader.agentType;
  }

  async listSessions(limit?: number): Promise<SessionSummary[]> {
    return this.reader.listSessions(limit);
  }

  async readSession(sessionId: string, offset?: number): Promise<ReadSessionResult | null> {
    return this.reader.readSession(sessionId, offset);
  }

  async readSessionBefore(sessionId: string, before: number): Promise<ReadSessionBeforeResult | null> {
    return this.reader.readSessionBefore(sessionId, before);
  }

  async getSessionCwd(sessionId: string): Promise<{ cwd: string | null } | null> {
    return this.reader.getSessionCwd(sessionId);
  }

  async getSessionMtimeMs(sessionId: string): Promise<number | null> {
    return this.reader.getSessionMtimeMs(sessionId);
  }

  async getSessionCreatedMs(sessionId: string): Promise<number | null> {
    return this.reader.getSessionCreatedMs(sessionId);
  }

  getSessionTailState(sessionId: string): Promise<SessionTailState> {
    return this.reader.getSessionTailState(sessionId);
  }
}
