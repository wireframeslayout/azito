import type { ServerConfig } from '../servers/Server';
import type { WorkerLaunch } from './WorkerLaunch';

/**
 * How a respawn starts the conversation it has an id for: `resume` the existing one, `new` = start it fresh under the
 * same id, or `attach` = the Claude Code daemon already holds it running and the launch opens it as the daemon's
 * client (`claude attach <id>`, Issue #639 — a `--resume` of a daemon-held conversation is refused).
 */
export type RespawnConversation = 'resume' | 'new' | 'attach';

export interface ISessionStrategy {
  readonly supportsSession: boolean;
  /** 起動時に session ID が確定せず、起動後のスキャンが必要か */
  readonly needsPostLaunchScan: boolean;
  /** 新規セッションのIDを起動時に指定する引数（無ければ空）。起動の末尾に足す */
  buildNewSessionArgs(sessionId: string): string[];
  /** 既存セッションを再開する引数（無ければ空）。起動の末尾に足す */
  buildResumeArgs(sessionId: string): string[];
  /**
   * 再起動（respawn）の起動。ペインのシェルの行にするかプログラムと引数にするかは、起動する側が決める。
   * `conversation` が `attach` のとき `attachId`（`claude attach` に渡す短い id）を使う。attach を持たない実装では無視する。
   */
  buildRespawnLaunch(agentSessionId: string | null, model: string | null, extraArgs: string | null, blockMcp?: boolean, conversation?: RespawnConversation, attachId?: string | null): WorkerLaunch | null;
  /**
   * The agent type whose conversation log (transcripts) tells whether a recorded session id has a conversation, which a respawn asks
   * before it resumes it (the agent only writes the file at the first message). null: a recorded id always has one (a Codex id is
   * read from an existing rollout), so it is resumed without asking.
   */
  readonly conversationLogAgentType: string | null;
  scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null>;
  excludeSessionId?(id: string): void;
}

export interface ISessionStrategyFactory {
  create(workerType: string | null): ISessionStrategy;
}
