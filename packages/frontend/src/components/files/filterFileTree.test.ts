import { describe, expect, it } from 'vitest';
import { filterFileTree } from './filterFileTree';
import type { TreeNode } from './useFileTree';

const tree: TreeNode[] = [{ name: 'parent', path: '/parent', type: 'directory', expanded: true, children: [
  { name: 'match.txt', path: '/parent/match.txt', type: 'file' },
  { name: 'other.txt', path: '/parent/other.txt', type: 'file' },
] }];

describe('filterFileTree', () => {
  it('keeps matching children and their ancestors', () => {
    expect(filterFileTree(tree, 'match')[0].children?.map((node) => node.name)).toEqual(['match.txt']);
    expect(tree[0].children).toHaveLength(2);
  });
  it('does not show unmatched children when their parent matches', () => {
    expect(filterFileTree(tree, 'parent')[0].children).toEqual([]);
  });
  it('keeps an active rename or create visible', () => {
    expect(filterFileTree(tree, 'none', '/parent/other.txt')[0].children?.map((node) => node.name)).toEqual(['other.txt']);
    expect(filterFileTree(tree, 'none', undefined, '/parent')).toHaveLength(1);
  });
});
