export interface IPrimaryWindowWaker {
  wake(windowId: number, serverName: string, opts?: {
    skipAgentLaunch?: boolean;
    gateAlreadyEnforced?: boolean;
  }): Promise<{ tmuxTarget: string }>;

  findRunningSession(
    taskId: number,
    agentSessionId: string,
    serverName: string,
  ): Promise<{ windowId: number; tmuxTarget: string } | null>;
}
