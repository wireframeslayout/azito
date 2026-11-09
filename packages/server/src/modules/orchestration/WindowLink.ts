import type { Window } from '../windows/Window';

export interface WindowLinkView {
  id: number;
  sourceWindowId: number;
  targetWindowId: number | null;
  taskId: number | null;
  kind: 'operation' | 'orchestration';
  source: 'manual' | 'auto';
  createdAt: string;
  lastInteractionAt: string | null;
  unlinkedAt: string | null;
  resolvedWindowId: number | null;
}

export interface OrchestratorSummary extends Window {
  links: { total: number; projectIds: number[]; serverNames: string[]; targets: Array<{ windowId: number | null; taskId: number | null }> };
  parentWindowId: number | null;
  lastInteractionAt: string | null;
}
