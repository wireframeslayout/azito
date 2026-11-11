import { isRelayRoutingName } from '@azito/shared';

export interface RelayableSubagent {
  id: string;
  routingName?: string | null;
  status: 'finished' | 'unknown';
}

export type SubagentRelay =
  | { kind: 'available'; name: string; status: 'unknown' }
  | { kind: 'unavailable'; reason: 'agent_outdated' | 'unavailable' | 'unnamed' | 'finished' | 'invalid_name' };

export function resolveSubagentRelay(agents: RelayableSubagent[] | null, selectedId: string): SubagentRelay {
  const agent = agents?.find((item) => item.id === selectedId);
  if (!agents || !agent) return { kind: 'unavailable', reason: 'unavailable' };
  if (agent.routingName === undefined) return { kind: 'unavailable', reason: 'agent_outdated' };
  const name = agent.routingName;
  if (agent.status === 'finished') return { kind: 'unavailable', reason: 'finished' };
  if (name === null) return { kind: 'unavailable', reason: 'unnamed' };
  if (!isRelayRoutingName(name, agents.map((item) => item.routingName))) return { kind: 'unavailable', reason: 'invalid_name' };
  return { kind: 'available', name, status: agent.status };
}
