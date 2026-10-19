import type { Pane } from '../pages/workspace/types';

export function paneRowBadge(pane: Pick<Pane, 'index' | 'handle'>): string {
  if (!pane.handle) return `%${pane.index}`;
  if (pane.handle.startsWith('p_')) return `#${pane.handle.slice(-4)}`;
  return pane.handle;
}
