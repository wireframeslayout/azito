import { useApi } from './useApi';

export interface AgentModelOption {
  id: string;
  label: string;
}

export interface AgentDefinition {
  type: string;
  label: string;
  kind: 'cli';
  launchable: boolean;
  contexts: ('worker' | 'subagent')[];
  models: AgentModelOption[];
  headlessCommand: string | null;
  /** Base interactive launch command (no model/extraArgs applied). null when not launchable. */
  launchCommand: string | null;
}

/**
 * サーバーの AgentRegistry(/api/agents)からエージェント種別カタログを取得する。
 * type / label / models / launchCommand をフロントに直書きせず、ここから取得する。
 */
export function useAgentDefinitions(context: 'worker' | 'subagent' = 'worker'): {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;
} {
  const { data, loading, error } = useApi<AgentDefinition[]>(`/agents?context=${context}`);
  return { agents: data ?? [], loading, error };
}
