export type AgentUnreachableReason = 'timeout' | 'refused' | 'unreachable' | 'circuit_open';

/** The hub could not reach an agent server over HTTP (or the circuit breaker is open for it). */
export class AgentUnreachableError extends Error {
  constructor(readonly serverName: string, readonly reason: AgentUnreachableReason) {
    super(`Agent server "${serverName}" is unreachable (${reason})`);
    this.name = 'AgentUnreachableError';
  }
}
