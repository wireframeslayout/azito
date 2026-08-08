import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
}

export interface TreeNode extends FileEntry {
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
}

async function updateNodes(
  nodes: TreeNode[],
  targetPath: string,
  updater: (node: TreeNode) => Promise<TreeNode>,
): Promise<TreeNode[]> {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.path === targetPath) {
      result.push(await updater(node));
    } else if (node.children) {
      result.push({ ...node, children: await updateNodes(node.children, targetPath, updater) });
    } else {
      result.push(node);
    }
  }
  return result;
}

export function useFileTree(serverName: string, rootPath: string) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    try {
      const entries = await api<FileEntry[]>(`/servers/${serverName}/files?path=${encodeURIComponent(dirPath)}`);
      if (!Array.isArray(entries)) return [];
      return entries.map((e) => ({
        ...e,
        children: e.type === 'directory' ? [] : undefined,
        loaded: false,
        expanded: false,
      }));
    } catch {
      return [];
    }
  }, [serverName]);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nodes = await loadDir(rootPath);
      setTree(nodes);
    } catch {
      setError('Failed to load directory');
    }
    setLoading(false);
  }, [rootPath, loadDir]);

  useEffect(() => { loadRoot(); }, [loadRoot]);

  const toggleDir = useCallback(async (dirPath: string) => {
    const updated = await updateNodes(treeRef.current, dirPath, async (node) => {
      if (!node.loaded) {
        const children = await loadDir(node.path);
        return { ...node, expanded: true, loaded: true, children };
      }
      return { ...node, expanded: !node.expanded };
    });
    setTree(updated);
  }, [loadDir]);

  const expandDir = useCallback(async (dirPath: string) => {
    const updated = await updateNodes(treeRef.current, dirPath, async (node) => {
      if (!node.loaded) {
        const children = await loadDir(node.path);
        return { ...node, expanded: true, loaded: true, children };
      }
      if (!node.expanded) return { ...node, expanded: true };
      return node;
    });
    setTree(updated);
  }, [loadDir]);

  const refreshDir = useCallback(async (dirPath: string) => {
    const updated = await updateNodes(treeRef.current, dirPath, async (node) => {
      const children = await loadDir(node.path);
      return { ...node, loaded: true, children };
    });
    setTree(updated);
  }, [loadDir]);

  const getSiblingNames = useCallback((parentPath: string): string[] => {
    const currentTree = treeRef.current;
    const findChildren = (nodes: TreeNode[]): string[] => {
      for (const node of nodes) {
        if (node.path === parentPath && node.children) {
          return node.children.map((c) => c.name);
        }
        if (node.children) {
          const found = findChildren(node.children);
          if (found.length > 0) return found;
        }
      }
      return [];
    };
    if (parentPath === rootPath) return currentTree.map((n) => n.name);
    return findChildren(currentTree);
  }, [rootPath]);

  return { tree, loading, error, loadRoot, toggleDir, expandDir, refreshDir, getSiblingNames };
}
