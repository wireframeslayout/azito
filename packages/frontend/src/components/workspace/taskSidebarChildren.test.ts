import { describe, expect, it } from 'vitest';
import type { Window } from '../../pages/workspace/types';
import { buildTaskWindowTree } from './taskSidebarChildren';

function window(id: number, label: string, isPrimary = false): Window {
  return { id, label, isPrimary, tmuxTarget: label } as Window;
}

describe('buildTaskWindowTree', () => {
  it('sorts the primary first, nests linked children in name order and leaves orphans at the top level', () => {
    const result = buildTaskWindowTree([window(3, 'z'), window(2, 'b'), window(1, 'primary', true), window(4, 'a')], new Map([[3, 1], [2, 1], [4, 99]]));
    expect(result.map(row => row.window.id)).toEqual([1, 4]);
    expect(result[0].children.map(row => row.window.id)).toEqual([2, 3]);
  });
});
