import { isSameWindowTarget } from '@azito/shared';
import type { AgentActivityInfo } from '../hooks/useAgentActivity';
import type { OrchestratorSummary, Task, Window } from '../pages/workspace/types';

export type OrchestratorStatus = 'active' | 'idle' | 'sleeping';
export interface AttentionTarget { windowId: number | null; taskId: number | null; kind?: 'operation' | 'orchestration' }
export interface AttentionContext { activityByWindowId: Map<number, AgentActivityInfo>; taskById: Map<number, Task> }
export interface OrchestratorNode {
  window: OrchestratorSummary;
  children: OrchestratorNode[];
  linkCount: number;
  projectIds: number[];
  attention: number | null;
  attentionIds: string[] | null;
}

export function buildAttentionContext(entries: Map<string, AgentActivityInfo>, allTasks: readonly Task[]): AttentionContext {
  const activityByWindowId = new Map<number, AgentActivityInfo>();
  for (const entry of entries.values()) {
    if (entry.windowId == null) continue;
    const previous = activityByWindowId.get(entry.windowId);
    if (!previous || entry.status === 'blocked') activityByWindowId.set(entry.windowId, entry);
  }
  return { activityByWindowId, taskById: new Map(allTasks.map((task) => [task.id, task])) };
}

const ATTENTION_STATUSES = new Set(['waiting_input', 'waiting_for_human', 'phase_review', 'pending_approval', 'failed']);
export function isAttentionTarget(target: AttentionTarget, ctx: AttentionContext): boolean {
  if (target.kind === 'operation') return false;
  const activity = target.windowId === null ? undefined : ctx.activityByWindowId.get(target.windowId);
  const task = target.taskId === null ? undefined : ctx.taskById.get(target.taskId);
  return activity?.status === 'blocked' || (task !== undefined && ATTENTION_STATUSES.has(task.status));
}

export type ActivityClassification = 'attention' | 'running' | 'idle' | 'completed' | 'unknown';
export function classifyActivity(input: { attention: boolean; working: boolean; completed: boolean; known: boolean }): ActivityClassification {
  if (input.attention) return 'attention';
  if (input.working) return 'running';
  if (input.completed) return 'completed';
  return input.known ? 'idle' : 'unknown';
}

export function matchesActivityWindow(entry: { windowId?: number; serverName: string; target: string }, window: Window): boolean {
  return entry.windowId === window.id || (entry.serverName === window.serverName && isSameWindowTarget(entry.target, window.tmuxTarget));
}

export function orchestratorStatus(w: Window, activity: Map<string, AgentActivityInfo>): OrchestratorStatus {
  if (w.sleeping) return 'sleeping';
  for (const entry of activity.values()) {
    if (entry.running && (entry.windowId === w.id || (entry.serverName === w.serverName && isSameWindowTarget(entry.target, w.tmuxTarget)))) return 'active';
  }
  return 'idle';
}

export function countAttention(node: OrchestratorNode): number | null {
  return countAttentionForest([node]);
}
export function countAttentionForest(nodes: readonly OrchestratorNode[]): number | null {
  const ids = new Set<string>();
  const visit = (node: OrchestratorNode): boolean => {
    if (node.attentionIds === null) return false;
    node.attentionIds.forEach((id) => ids.add(id));
    return node.children.every(visit);
  };
  return nodes.every(visit) ? ids.size : null;
}

export function buildOrchestratorTree(windows: readonly OrchestratorSummary[], ctx?: AttentionContext): OrchestratorNode[] {
  const byId = new Map(windows.map((window) => [window.id, window]));
  const children = new Map<number, OrchestratorSummary[]>();
  for (const window of windows) {
    if (window.parentWindowId !== null && byId.has(window.parentWindowId)) {
      const siblings = children.get(window.parentWindowId) ?? [];
      siblings.push(window); children.set(window.parentWindowId, siblings);
    }
  }
  const seen = new Set<number>();
  const markDescendants = (id: number): void => {
    for (const child of children.get(id) ?? []) { if (!seen.has(child.id)) { seen.add(child.id); markDescendants(child.id); } }
  };
  const build = (window: OrchestratorSummary, depth: number): OrchestratorNode => {
    seen.add(window.id);
    const candidates: AttentionTarget[] = [{ windowId: window.id, taskId: null }, ...window.links.targets];
    const ids = ctx ? [...new Set(candidates.filter((target) => isAttentionTarget(target, ctx)).map((target) => target.windowId !== null ? `window:${target.windowId}` : `task:${target.taskId}`))] : null;
    if (depth >= 8) markDescendants(window.id);
    return { window, linkCount: window.links.total, projectIds: window.links.projectIds, attention: ids?.length ?? null, attentionIds: ids, children: depth >= 8 ? [] : (children.get(window.id) ?? []).filter((child) => !seen.has(child.id)).map((child) => build(child, depth + 1)) };
  };
  const roots = windows.filter((window) => window.parentWindowId === null || !byId.has(window.parentWindowId));
  const result = roots.filter((window) => !seen.has(window.id)).map((window) => build(window, 0));
  for (const window of windows) if (!seen.has(window.id)) result.push(build(window, 0));
  return result;
}
