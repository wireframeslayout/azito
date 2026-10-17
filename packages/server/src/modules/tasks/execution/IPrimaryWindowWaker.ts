import type { MuxDriverKind } from '@azito/shared';
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
  /** `kind` is the mux the window lives in. */
  ): Promise<{ windowId: number; tmuxTarget: string; kind: MuxDriverKind } | null>;
}
