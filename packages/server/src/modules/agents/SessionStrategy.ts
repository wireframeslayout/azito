import type { ServerConfig } from '../servers/Server';
import type { WorkerLaunch } from './WorkerLaunch';

/** How a respawn starts the conversation it has an id for: `resume` the existing one, or `new` = start it fresh under the same id. */
export type RespawnConversation = 'resume' | 'new';

export interface ISessionStrategy {
  readonly supportsSession: boolean;
  /** 起動時に session ID が確定せず、起動後のスキャンが必要か */
  readonly needsPostLaunchScan: boolean;
  /** 新規セッションのIDを起動時に指定する引数（無ければ空）。起動の末尾に足す */
  buildNewSessionArgs(sessionId: string): string[];
  /** 既存セッションを再開する引数（無ければ空）。起動の末尾に足す */
  buildResumeArgs(sessionId: string): string[];
  /** 再起動（respawn）の起動。ペインのシェルの行にするかプログラムと引数にするかは、起動する側が決める。 */
  buildRespawnLaunch(agentSessionId: string | null, model: string | null, extraArgs: string | null, blockMcp?: boolean, conversation?: RespawnConversation): WorkerLaunch | null;
  /**
   * Whether the conversation `sessionId` exists on the host, to decide between resuming it and starting it fresh under the same id.
   * Throws {@link ConversationCheckError} when that cannot be told (never answers `new` for "could not read").
   */
  resolveRespawnConversation(server: ServerConfig, workingDirectory: string | null, sessionId: string): Promise<RespawnConversation>;
  scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null>;
  excludeSessionId?(id: string): void;
}

export interface ISessionStrategyFactory {
  create(workerType: string | null): ISessionStrategy;
}
