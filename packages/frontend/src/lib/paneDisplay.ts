import type { Pane } from '../pages/workspace/types';

export function paneDisplayName(pane: Pick<Pane, 'title' | 'command'>): string {
  return pane.title && pane.title !== pane.command ? pane.title : pane.command;
}
