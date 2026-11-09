import { describe, expect, it } from 'vitest';
import { buildOrchestrationTree, countAttention, orchestratorState } from './orchestrationModel';
import type { OrchestratorSummary } from '../pages/workspace/types';

function window(id: number, parentWindowId: number | null): OrchestratorSummary {
  return { id, parentWindowId, lastInteractionAt: null, ownerType: 'server', role: 'orchestrator', originProjectId: null, serverName: 'local', tmuxTarget: 's:w', isPrimary: false, windowType: 'agent', links: { total: 0, projectIds: [], serverNames: [] } };
}

describe('orchestration model', () => {
  it('builds a tree and treats missing parents as roots', () => {
    const tree = buildOrchestrationTree([window(1, null), window(2, 1), window(3, 99)]);
    expect(tree.map((node) => node.window.id)).toEqual([1, 3]);
    expect(tree[0].children[0].window.id).toBe(2);
  });
  it('limits depth and handles cycles', () => {
    const chain = Array.from({ length: 10 }, (_, id) => window(id, id ? id - 1 : null));
    let node = buildOrchestrationTree(chain)[0];
    for (let i = 0; i < 8; i++) node = node.children[0];
    expect(node.children).toEqual([]);
    expect(buildOrchestrationTree([window(1, 2), window(2, 1)])[0].children[0].children).toEqual([]);
  });
  it('prioritizes sleep and deduplicates attention targets, excluding operations', () => {
    expect(orchestratorState({ ...window(1, null), sleeping: true }, 'blocked')).toBe('sleeping');
    const target = { id: 'a', kind: 'orchestration' as const, needsApproval: true, hasQuestion: true, failed: false };
    expect(countAttention([target, target, { ...target, id: 'b', kind: 'operation' }])).toBe(1);
  });
});
