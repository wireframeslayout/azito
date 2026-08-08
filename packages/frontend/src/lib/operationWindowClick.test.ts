import { describe, it, expect } from 'vitest';
import { resolveOperationClick } from './operationWindowClick';

describe('resolveOperationClick', () => {
  it('routes to the clicked row\'s own task, not a re-derived one, when two tasks share a physical window', () => {
    // 同じ物理ウィンドウ（server-a / sess:0）を持つ2つのタスク行。
    // 「物理ターゲットから Map を引き直す」実装だと後勝ちの taskId に固定されてしまう不具合の再現。
    const rowForTaskA = { taskId: 1, serverName: 'server-a', tmuxTarget: 'sess:0' };
    const rowForTaskB = { taskId: 2, serverName: 'server-a', tmuxTarget: 'sess:0' };

    const decisionA = resolveOperationClick(rowForTaskA, 'server-a', 'sess:0');
    const decisionB = resolveOperationClick(rowForTaskB, 'server-a', 'sess:0');

    expect(decisionA).toEqual({ kind: 'task', taskId: 1, serverName: 'server-a', target: 'sess:0' });
    expect(decisionB).toEqual({ kind: 'task', taskId: 2, serverName: 'server-a', target: 'sess:0' });
  });

  it('uses the clicked row\'s own window target, not the pane-suffixed click target', () => {
    // ペイン展開時、クリックされた target はペインまで含む（sess:0.1 等）が、タスクへ遷移する際は
    // 行本体の tmuxTarget（ウィンドウ単位）を使う。
    const row = { taskId: 5, serverName: 'server-b', tmuxTarget: 'sess:0' };

    const decision = resolveOperationClick(row, 'server-b', 'sess:0.1');

    expect(decision).toEqual({ kind: 'task', taskId: 5, serverName: 'server-b', target: 'sess:0' });
  });

  it('falls back to a plain pane click when the row has no task (e.g. an offline/unresolved window)', () => {
    const row = { taskId: null, serverName: 'server-a', tmuxTarget: 'sess:0' };

    const decision = resolveOperationClick(row, 'server-a', 'sess:0.2');

    expect(decision).toEqual({ kind: 'pane', serverName: 'server-a', target: 'sess:0.2' });
  });
});
