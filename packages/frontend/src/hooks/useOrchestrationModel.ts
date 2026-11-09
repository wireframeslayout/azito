import { useAgentActivity } from './useAgentActivity';
import { useOrchestrators } from './useOrchestrators';
import { useWorkspaceCatalog } from './useWorkspaceCatalog';
import { buildAttentionContext, buildOrchestratorTree, countAttentionForest } from '../lib/orchestrationModel';

export function useOrchestrationModel() {
  const { windows, status } = useOrchestrators();
  const { entries, snapshotStatus } = useAgentActivity();
  const { allTasks, projectsLoaded, error } = useWorkspaceCatalog();
  const ready = status === 'ready' && snapshotStatus === 'ready' && projectsLoaded && !error;
  const tree = buildOrchestratorTree(windows, ready ? buildAttentionContext(entries, allTasks) : undefined);
  return { tree, attention: ready ? countAttentionForest(tree) : null, activity: entries, ready };
}
