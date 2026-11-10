import { isRelayRoutingName } from '@azito/shared';

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
  if (agent.status === 'finished' || !isRelayRoutingName(name, agents.map((item) => item.routingName))) return { kind: 'unavailable', reason: 'unavailable' };
  return { kind: 'available', name, status: agent.status };
}
