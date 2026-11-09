import { describe, expect, it } from 'vitest';
import { buildAttentionContext, buildOrchestratorTree, countAttention, isAttentionTarget, orchestratorStatus, type AttentionContext } from './orchestrationModel';
import type { OrchestratorSummary, Task } from '../pages/workspace/types';
import type { AgentActivityInfo } from '../hooks/useAgentActivity';

function window(id: number, parentWindowId: number | null): OrchestratorSummary {
  return { id, parentWindowId, lastInteractionAt: null, ownerType: 'server', role: 'orchestrator', originProjectId: null, serverName: 'local', tmuxTarget: `s:w${id}`, isPrimary: false, windowType: 'agent', links: { total: 0, projectIds: [], serverNames: [], targets: [] } };
}
function activity(id: number, status: 'working' | 'blocked' = 'working'): AgentActivityInfo {
  return { windowId: id, serverName: 'local', target: `s:w${id}`, running: true, source: 'manual', status };
}
const ctx = (activities: AgentActivityInfo[] = [], tasks: Array<{ id: number; status: string }> = []): AttentionContext => ({ activityByWindowId: new Map(activities.map((item) => [item.windowId!, item])), taskById: new Map(tasks.map((task) => [task.id, task as Task])) });

describe('orchestration model', () => {
  it('builds a context with blocked activity preferred regardless of order', () => {
    const blocked = activity(4, 'blocked'); const working = activity(4);
    const task = { id: 7, status: 'failed' } as Task;
    for (const entries of [[blocked, working], [working, blocked]]) {
      const result = buildAttentionContext(new Map(entries.map((entry, index) => [String(index), entry])), [task]);
      expect(result.activityByWindowId.get(4)).toBe(blocked);
      expect(result.taskById.get(7)).toBe(task);
    }
  });
  it('builds nested nodes and treats missing parents as roots', () => {
    const tree = buildOrchestratorTree([window(1, null), window(2, 1), window(3, 99)], ctx());
    expect(tree.map((node) => node.window.id)).toEqual([1, 3]);
    expect(tree[0].children[0].window.id).toBe(2);
  });
  it('limits depth and handles cycles', () => {
    const chain = Array.from({ length: 10 }, (_, id) => window(id, id ? id - 1 : null));
    let node = buildOrchestratorTree(chain, ctx())[0];
    for (let i = 0; i < 8; i++) node = node.children[0];
    expect(node.children).toEqual([]);
    expect(buildOrchestratorTree([window(1, 2), window(2, 1)], ctx())[0].children[0].children).toEqual([]);
  });
  it('gives sleeping precedence over active, then idle', () => {
    const entries = new Map([['a', activity(1, 'blocked')]]);
    expect(orchestratorStatus({ ...window(1, null), sleeping: true }, entries)).toBe('sleeping');
    expect(orchestratorStatus(window(1, null), entries)).toBe('active');
    expect(orchestratorStatus(window(2, null), entries)).toBe('idle');
  });
  it.each(['waiting_input', 'waiting_for_human', 'phase_review', 'pending_approval', 'failed'])('detects task status %s', (status) => {
    expect(isAttentionTarget({ windowId: null, taskId: 10 }, ctx([], [{ id: 10, status }]))).toBe(true);
  });
  it('detects blocked activity and excludes operations', () => {
    const context = ctx([activity(4, 'blocked')]);
    expect(isAttentionTarget({ windowId: 4, taskId: null }, context)).toBe(true);
    expect(isAttentionTarget({ windowId: 4, taskId: null, kind: 'operation' }, context)).toBe(false);
    expect(isAttentionTarget({ windowId: 5, taskId: null }, context)).toBe(false);
  });
  it('counts descendants once and keeps unavailable data unknown', () => {
    const parent = window(1, null); const child = window(2, 1);
    parent.links.targets = [{ windowId: 4, taskId: 10 }, { windowId: 4, taskId: null }];
    child.links.targets = [{ windowId: 4, taskId: null }, { windowId: null, taskId: 11 }];
    const tree = buildOrchestratorTree([parent, child], ctx([activity(4, 'blocked')], [{ id: 10, status: 'failed' }, { id: 11, status: 'waiting_input' }]));
    expect(countAttention(tree[0])).toBe(2);
    expect(countAttention(buildOrchestratorTree([parent, child])[0])).toBeNull();
  });
});
