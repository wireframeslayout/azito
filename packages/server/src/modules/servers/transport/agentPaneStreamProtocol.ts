/** Agent endpoint where the hub registers (POST) and releases (DELETE ?path=) a pane-stream file for `/ws?mode=file-tail`. */
export const AGENT_PANE_STREAMS_PATH = '/api/pane-streams';

/** The agent does not have the pane-stream endpoint (HTTP 404): it is older than this hub. Retrying cannot help. */
export class AgentOutdatedError extends Error {
  constructor(readonly serverName: string) {
    super(`agent_outdated: agent server "${serverName}" does not support pane-stream registration (update the agent)`);
    this.name = 'AgentOutdatedError';
  }
}
