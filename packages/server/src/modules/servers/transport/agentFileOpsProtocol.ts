/** The agent has `/api/fileops` but not this operation (HTTP 400: its request schema does not know the `op`): it is older than this hub. Retrying cannot help. */
export class AgentFileOpOutdatedError extends Error {
  constructor(readonly serverName: string, readonly op: string) {
    super(`agent_outdated: agent server "${serverName}" does not support the file operation "${op}" (update the agent)`);
    this.name = 'AgentFileOpOutdatedError';
  }
}
