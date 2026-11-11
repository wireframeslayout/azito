import type { TreeNode } from './useFileTree';

export function filterFileTree(nodes: TreeNode[], filter: string, renamePath?: string, createParentPath?: string): TreeNode[] {
  const query = filter.toLocaleLowerCase();
  const walk = (items: TreeNode[]): TreeNode[] => items.flatMap((node) => {
    const children = node.expanded && node.children ? walk(node.children) : [];
    const matches = node.name.toLocaleLowerCase().includes(query);
    const editing = renamePath === node.path || createParentPath === node.path;
    return matches || children.length || editing ? [{ ...node, children: node.children ? children : undefined }] : [];
  });
  return walk(nodes);
}
