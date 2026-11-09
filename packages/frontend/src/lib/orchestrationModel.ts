import type { OrchestratorSummary } from '../pages/workspace/types';

export type OrchestratorState = 'running' | 'idle' | 'sleeping';
export interface OrchestrationNode {
  window: OrchestratorSummary;
  children: OrchestrationNode[];
}
export interface AttentionTarget {
  id: string;
  kind: 'operation' | 'orchestration';
  needsApproval: boolean;
  hasQuestion: boolean;
  failed: boolean;
}

export function orchestratorState(window: OrchestratorSummary, activity: 'working' | 'blocked' | null): OrchestratorState {
  if (window.sleeping) return 'sleeping';
  return activity ? 'running' : 'idle';
}

export function isAttentionTarget(target: AttentionTarget): boolean {
  return target.kind === 'orchestration' && (target.needsApproval || target.hasQuestion || target.failed);
}

export function countAttention(targets: readonly AttentionTarget[]): number {
  return new Set(targets.filter(isAttentionTarget).map((target) => target.id)).size;
}

export function buildOrchestrationTree(windows: readonly OrchestratorSummary[]): OrchestrationNode[] {
  const byId = new Map(windows.map((window) => [window.id, window]));
  const children = new Map<number, OrchestratorSummary[]>();
  for (const window of windows) {
    if (window.parentWindowId !== null && byId.has(window.parentWindowId)) {
      const siblings = children.get(window.parentWindowId) ?? [];
      siblings.push(window);
      children.set(window.parentWindowId, siblings);
    }
  }
  const seen = new Set<number>();
  const markDescendants = (id: number): void => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      markDescendants(child.id);
    }
  };
  const build = (window: OrchestratorSummary, depth: number): OrchestrationNode => {
    seen.add(window.id);
    if (depth >= 8) {
      markDescendants(window.id);
      return { window, children: [] };
    }
    return { window, children: (children.get(window.id) ?? []).filter((child) => !seen.has(child.id)).map((child) => build(child, depth + 1)) };
  };
  const roots = windows.filter((window) => window.parentWindowId === null || !byId.has(window.parentWindowId));
  const result = roots.filter((window) => !seen.has(window.id)).map((window) => build(window, 0));
  for (const window of windows) if (!seen.has(window.id)) result.push(build(window, 0));
  return result;
}
