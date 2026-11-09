import type { Database } from 'better-sqlite3';
import type { WindowLinkView } from './WindowLink';

interface Row {
  id: number; source_window_id: number; target_window_id: number | null; task_id: number | null;
  kind: WindowLinkView['kind']; source: WindowLinkView['source']; created_at: string;
  last_interaction_at: string | null; unlinked_at: string | null; resolved_window_id: number | null;
  project_id: number | null; server_name: string | null;
}

export class SqliteWindowLinkRepository {
  constructor(private db: Database) {}
  private select(where: string, args: unknown[]): Row[] {
    return this.db.prepare(`SELECT l.*, COALESCE(l.target_window_id, primary_window.id) AS resolved_window_id,
      CASE WHEN l.target_window_id IS NOT NULL THEN target.project_id ELSE task.project_id END AS project_id,
      CASE WHEN l.target_window_id IS NOT NULL THEN target.server_name ELSE COALESCE(primary_window.server_name, task.server_name) END AS server_name
      FROM window_links l
      LEFT JOIN windows target ON target.id = l.target_window_id
      LEFT JOIN tasks task ON task.id = l.task_id
      LEFT JOIN windows primary_window ON primary_window.id = (SELECT id FROM windows WHERE owner_type='task' AND task_id=l.task_id AND is_primary=1 ORDER BY created_at ASC, id ASC LIMIT 1)
      WHERE ${where} ORDER BY l.id`).all(...args) as Row[];
  }
  list(source: number, includeUnlinked: boolean, kind?: WindowLinkView['kind']): WindowLinkView[] {
    return this.select(`l.source_window_id=? ${includeUnlinked ? '' : 'AND l.unlinked_at IS NULL'} ${kind ? 'AND l.kind=?' : ''}`, kind ? [source, kind] : [source]).map(r => ({
      id: r.id, sourceWindowId: r.source_window_id, targetWindowId: r.target_window_id, taskId: r.task_id,
      kind: r.kind, source: r.source, createdAt: r.created_at, lastInteractionAt: r.last_interaction_at,
      unlinkedAt: r.unlinked_at, resolvedWindowId: r.resolved_window_id,
    }));
  }
  activeForOrchestrators(): Row[] {
    return this.select("l.unlinked_at IS NULL AND EXISTS (SELECT 1 FROM windows source WHERE source.id=l.source_window_id AND source.role='orchestrator')", []);
  }
  incomingSources(id: number): number[] {
    return (this.db.prepare('SELECT DISTINCT source_window_id AS id FROM window_links WHERE target_window_id=? AND unlinked_at IS NULL').all(id) as Array<{ id: number }>).map(r => r.id);
  }
  activeFrom(id: number): Array<{ id: number; targetWindowId: number | null }> {
    return this.db.prepare('SELECT id, target_window_id AS targetWindowId FROM window_links WHERE source_window_id=? AND unlinked_at IS NULL').all(id) as Array<{ id: number; targetWindowId: number | null }>;
  }
}
