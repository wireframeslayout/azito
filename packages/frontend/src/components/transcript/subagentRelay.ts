export interface RelayableSubagent {
  id: string;
  routingName?: string | null;
  status: 'finished' | 'unknown';
}

export type SubagentRelay =
  | { kind: 'available'; name: string; status: 'unknown' }
  | { kind: 'unavailable'; reason: 'agent_outdated' | 'unavailable' };

export function resolveSubagentRelay(agents: RelayableSubagent[] | null, selectedId: string): SubagentRelay {
  const agent = agents?.find((item) => item.id === selectedId);
  if (!agents || !agent) return { kind: 'unavailable', reason: 'unavailable' };
  if (agent.routingName === undefined) return { kind: 'unavailable', reason: 'agent_outdated' };
  const name = agent.routingName;
  if (!name || agent.status === 'finished' || agents.filter((item) => item.routingName === name).length !== 1) return { kind: 'unavailable', reason: 'unavailable' };
  return { kind: 'available', name, status: agent.status };
}
