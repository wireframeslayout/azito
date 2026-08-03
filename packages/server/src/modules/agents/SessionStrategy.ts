import type { ServerConfig } from '../servers/Server';

export interface ISessionStrategy {
  readonly supportsSession: boolean;
  /** 起動時に session ID が確定せず、起動後のスキャンが必要か */
  readonly needsPostLaunchScan: boolean;
  buildNewSessionFlags(sessionId: string): string;
  buildResumeFlags(sessionId: string): string;
  buildRespawnCommand(agentSessionId: string | null, model: string | null, extraArgs: string | null): string | null;
  scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null>;
  excludeSessionId?(id: string): void;
}

export interface ISessionStrategyFactory {
  create(workerType: string | null): ISessionStrategy;
}
