import type { ServerConfig } from '../servers/Server';
import type { ShellDialect } from '../../shared/os/shellDialect';

export interface ISessionStrategy {
  readonly supportsSession: boolean;
  /** 起動時に session ID が確定せず、起動後のスキャンが必要か */
  readonly needsPostLaunchScan: boolean;
  buildNewSessionFlags(sessionId: string): string;
  buildResumeFlags(sessionId: string): string;
  /** `dialect`: the shell of the pane the line is typed into (the target host's). */
  buildRespawnCommand(agentSessionId: string | null, model: string | null, extraArgs: string | null, dialect: ShellDialect, blockMcp?: boolean): string | null;
  scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null>;
  excludeSessionId?(id: string): void;
}

export interface ISessionStrategyFactory {
  create(workerType: string | null): ISessionStrategy;
}
