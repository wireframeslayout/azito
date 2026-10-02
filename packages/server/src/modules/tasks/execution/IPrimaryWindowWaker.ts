import type { ServerConfig } from '../../servers/Server';

export interface IPrimaryWindowWaker {
  wake(windowId: number, serverName: string, opts?: {
    skipAgentLaunch?: boolean;
    gateAlreadyEnforced?: boolean;
    inLockGate?: (freshServer: ServerConfig) => void;
  }): Promise<{ tmuxTarget: string }>;

  findRunningSession(
    taskId: number,
    agentSessionId: string,
    serverName: string,
  ): Promise<{ windowId: number; tmuxTarget: string } | null>;
}
