import type { SqliteDatabase } from '../../shared/db/Database';

export interface ServerAlias {
  oldName: string;
  newName: string;
}

/**
 * The old names of servers that migration 079 merged into another (`local-misao` -> `local`). They exist only
 * because a pane started before the merge still carries the old `serverName` in its hook environment and a
 * browser may still hold saved tabs for it.
 *
 * TODO(#313): compatibility for one release only. Remove this repository, the `server_aliases` table (new migration),
 * the webhook and supervisor-register resolution, `aliases` in GET /api/servers and the frontend tab migration after
 * the release that ships migration 079. Only once every machine's hook configuration and running supervisors no
 * longer name an old server: `harness/setup.sh --server-name <merge target>` must have been re-run on it (079 logs
 * this), and panes started before the merge must have been restarted.
 */
export interface IServerAliasRepository {
  /**
   * The server an old name was merged into, or the name itself when it is not an alias. A server that exists under
   * the name always wins: a server created later with an old name takes the name over from its alias.
   */
  resolve(name: string): string;
  findAll(): ServerAlias[];
}

export class SqliteServerAliasRepository implements IServerAliasRepository {
  private resolveStmt;
  private listStmt;

  constructor(db: SqliteDatabase) {
    this.resolveStmt = db.prepare('SELECT new_name FROM server_aliases WHERE old_name = ? AND old_name NOT IN (SELECT name FROM servers)');
    this.listStmt = db.prepare('SELECT old_name, new_name FROM server_aliases WHERE old_name NOT IN (SELECT name FROM servers) ORDER BY old_name');
  }

  resolve(name: string): string {
    const row = this.resolveStmt.get(name) as { new_name: string } | undefined;
    return row ? row.new_name : name;
  }

  findAll(): ServerAlias[] {
    return (this.listStmt.all() as Array<{ old_name: string; new_name: string }>)
      .map((r) => ({ oldName: r.old_name, newName: r.new_name }));
  }
}
