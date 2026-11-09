import { describe, expect, it } from 'vitest';
import type { Task, Window } from '../pages/workspace/types';
import { buildOpenTabsTree, visibleMaximizeWindows } from './maximizeTreeModel';

const win = (id: number, primary = false): Window => ({ id, isPrimary: primary, label: String(id), tmuxTarget: String(id) } as Window);

describe('open tabs maximize tree', () => {
  it('deduplicates task tabs, preserves tab order and uses the task hierarchy', () => {
    const one = win(1, true), two = win(2), three = win(3);
    const task = { id: 4, windows: [two, one] } as Task;
    const rows = buildOpenTabsTree([{ kind: 'window', windowId: 3 }, { kind: 'window', windowId: 2 }, { kind: 'task', taskId: 4 }], [task], new Map([[3, three]]), new Map([[2, 1]]));
    expect(rows.map(row => row.key)).toEqual(['window:3', 'task:4']);
    expect(visibleMaximizeWindows(rows, new Set(['task:4', 'window:1']))).toEqual([3, 1, 2]);
    expect(visibleMaximizeWindows(rows, new Set())).toEqual([3]);
  });
  it('omits unresolved windows and leaves a task without a primary unselectable', () => {
    const task = { id: 4, windows: [win(2)] } as Task;
    const rows = buildOpenTabsTree([{ kind: 'window', windowId: 99 }, { kind: 'task', taskId: 4 }], [task], new Map(), new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === 'task' && rows[0].windowId).toBeNull();
  });
});
