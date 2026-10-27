import type {
  ReadSessionBeforeResult,
  ReadSessionResult,
  ListSessionsOptions,
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

  async listSessions(limit?: number, options?: ListSessionsOptions): Promise<SessionSummary[]> {
    return this.reader.listSessions(limit, options);
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

  async sessionExists(sessionId: string): Promise<boolean> {
    if (!this.reader.sessionExists) throw new Error(`The ${this.reader.agentType} reader cannot tell whether a session exists`);
    return this.reader.sessionExists(sessionId);
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
