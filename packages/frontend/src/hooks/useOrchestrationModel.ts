import { useAgentActivity, type AgentActivityInfo } from './useAgentActivity';
import { useOrchestrators } from './useOrchestrators';
import { useWorkspaceCatalog } from './useWorkspaceCatalog';
import { buildOrchestratorTree, countAttentionForest } from '../lib/orchestrationModel';

export function useOrchestrationModel() {
  const { windows, status } = useOrchestrators();
  const { entries, snapshotStatus } = useAgentActivity();
  const { allTasks, projectsLoaded, error } = useWorkspaceCatalog();
  const ready = status === 'ready' && snapshotStatus === 'ready' && projectsLoaded && !error;
  const activityByWindowId = new Map<number, AgentActivityInfo>();
  for (const entry of entries.values()) {
    if (entry.windowId == null) continue;
    const previous = activityByWindowId.get(entry.windowId);
    if (!previous || entry.status === 'blocked') activityByWindowId.set(entry.windowId, entry);
  }
  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const tree = buildOrchestratorTree(windows, ready ? { activityByWindowId, taskById } : undefined);
  return { tree, attention: ready ? countAttentionForest(tree) : null, activity: entries, ready };
}
