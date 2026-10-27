/** The agent has `/api/fileops` but not this operation (HTTP 400: its request schema does not know the `op`): it is older than this hub. Retrying cannot help. */
export class AgentFileOpOutdatedError extends Error {
  constructor(readonly serverName: string, readonly op: string) {
    super(`agent_outdated: agent server "${serverName}" does not support the file operation "${op}" (update the agent)`);
    this.name = 'AgentFileOpOutdatedError';
  }
}

/** The file operations an agent may predate: for these, a 400 that rejects the `op` itself means the agent is older than this hub (see {@link rejectsOperationName}). */
export const FILE_OPS_ADDED_LATER: ReadonlySet<string> = new Set(['searchContent', 'writeOwnerOnly', 'unlink']);

/**
 * Whether the body of an agent's `400 invalid_file_op` says the operation itself (`op`) is unknown to it, as opposed to a field of
 * a known one being out of range. The agent's `message` is the JSON of the schema's issues; an issue on the path `["op"]` is the former.
 */
export function rejectsOperationName(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    const message = typeof parsed === 'object' && parsed !== null ? (parsed as { message?: unknown }).message : undefined;
    if (typeof message !== 'string') return false;
    const issues: unknown = JSON.parse(message);
    return Array.isArray(issues) && issues.some((issue: unknown) => {
      const path = typeof issue === 'object' && issue !== null ? (issue as { path?: unknown }).path : undefined;
      return Array.isArray(path) && path.length === 1 && path[0] === 'op';
    });
  } catch {
    return false;
  }
}
