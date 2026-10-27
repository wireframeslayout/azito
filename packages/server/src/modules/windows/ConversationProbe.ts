import type { ServerConfig } from '../servers/Server';

/**
 * Whether the conversation (session) a window recorded exists on its server, asked before a respawn resumes it. It looks up the session
 * by its id in the conversation logs of the machine that runs the agent (its own HOME / CLAUDE_CONFIG_DIR, every project folder), never
 * by the window's directory. Resolves false only when the log was read and the conversation is not there; anything that stops the answer
 * (unreadable log, agent unreachable or outdated, a server whose logs cannot be read) throws a ConversationCheckError.
 */
export interface ConversationProbe {
  exists(server: ServerConfig, agentType: string, sessionId: string): Promise<boolean>;
}
