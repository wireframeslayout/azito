import { z } from 'zod';

/** Agent endpoint (behind the agent token) where an agent reports the host it runs on. Not part of `/health`, which needs no token. */
export const AGENT_HOST_PATH = '/api/host';

/**
 * What an agent says about its own host. `platform` / `arch` are Node's values as they are (the hub narrows them with
 * `toHostProfile`, so an OS the hub does not know is `unsupported_host` there). `shell` is the agent process's `$SHELL`
 * (a Windows host: `%ComSpec%`), null when the process has none. `homeDir` / `tmpDir` are the agent process's own home and temp
 * folders in the host's notation (the hub names the files of a task under `tmpDir`); an agent from before they were reported leaves them out,
 * which is a Unix agent whose temp folder is `/tmp` (a Windows agent always reports them).
 */
const agentHostInfoSchema = z.object({
  platform: z.string().min(1),
  arch: z.string().min(1),
  shell: z.string().min(1).nullable(),
  homeDir: z.string().min(1).optional(),
  tmpDir: z.string().min(1).optional(),
  /** The agent process's own node executable (`process.execPath`): what a worker on the host can run a Node script with without `node` being on its PATH. */
  execPath: z.string().min(1).optional(),
});
export type AgentHostInfo = z.infer<typeof agentHostInfoSchema>;

/** Reads an agent's `GET /api/host` body. A body of another shape is an error: the agent is not one this hub understands. */
export function parseAgentHostInfo(body: unknown): AgentHostInfo {
  return agentHostInfoSchema.parse(body);
}

/** The agent has no `GET /api/host` (HTTP 404): it is older than this hub. Its host stays unrecorded and its existing operations keep working. */
export class AgentHostOutdatedError extends Error {
  constructor(readonly serverName: string) {
    super(`agent_outdated: agent server "${serverName}" cannot report its host (update the agent)`);
    this.name = 'AgentHostOutdatedError';
  }
}
