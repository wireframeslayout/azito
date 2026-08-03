import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface BrowserTabSnapshot {
  tabId: string;
  url: string | null;
}

export class SqliteBrowserSnapshotRepository {
  private deleteGroupStmt;
  private insertStmt;
  private loadGroupStmt;

  constructor(private db: SqliteDatabase) {
    this.deleteGroupStmt = db.prepare(
      'DELETE FROM browser_tab_snapshots WHERE server_name = ? AND group_id = ?',
    );
    this.insertStmt = db.prepare(
      'INSERT INTO browser_tab_snapshots (server_name, group_id, tab_id, url, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.loadGroupStmt = db.prepare(
      'SELECT tab_id, url FROM browser_tab_snapshots WHERE server_name = ? AND group_id = ? ORDER BY tab_id',
    );
  }

  saveGroup(serverName: string, groupId: string, snapshots: BrowserTabSnapshot[]): void {
    const now = Date.now();
    const run = this.db.transaction(() => {
      this.deleteGroupStmt.run(serverName, groupId);
      for (const { tabId, url } of snapshots) {
        this.insertStmt.run(serverName, groupId, tabId, url, now);
      }
    });
    run();
  }

  loadGroup(serverName: string, groupId: string): BrowserTabSnapshot[] {
    const rows = this.loadGroupStmt.all(serverName, groupId) as { tab_id: string; url: string | null }[];
    return rows.map((r) => ({ tabId: r.tab_id, url: r.url }));
  }

  deleteGroup(serverName: string, groupId: string): void {
    this.deleteGroupStmt.run(serverName, groupId);
  }
}
