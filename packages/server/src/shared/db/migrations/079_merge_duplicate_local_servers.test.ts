import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../Database';
import * as m079 from './079_merge_duplicate_local_servers';

// A database that has been through every migration (including 079, which is a no-op on the seeded single `local`).
// The tests add the duplicate servers afterwards and run 079 again, as it would on an upgraded hub.
const run = (db: SqliteDatabase): void => db.transaction(() => m079.up(db))();

function addServer(db: SqliteDatabase, name: string, defaultMux: 'tmux' | 'misao', muxRuntime = 'system'): void {
  db.prepare("INSERT INTO servers (name, type, default_mux, mux_runtime) VALUES (?, 'local', ?, ?)").run(name, defaultMux, muxRuntime);
}

function addWindow(db: SqliteDatabase, server: string, target: string, opts: { muxRef?: string; taskId?: number } = {}): number {
  return Number(db.prepare(
    `INSERT INTO windows (owner_type, project_id, task_id, server_name, tmux_target, mux_ref, window_type)
     VALUES (?, ?, ?, ?, ?, ?, 'terminal')`,
  ).run(opts.taskId ? 'task' : 'project', opts.taskId ? null : 1, opts.taskId ?? null, server, target, opts.muxRef ?? null).lastInsertRowid);
}

const names = (db: SqliteDatabase): string[] =>
  (db.prepare('SELECT name FROM servers ORDER BY rowid').all() as Array<{ name: string }>).map((r) => r.name);
const aliases = (db: SqliteDatabase): unknown[] => db.prepare('SELECT old_name, new_name FROM server_aliases ORDER BY old_name').all();

describe('migration 079: merge duplicate local servers', () => {
  let db: SqliteDatabase;
  beforeEach(() => {
    db = openDatabase(':memory:');
    db.prepare("INSERT INTO projects (id, name, slug) VALUES (1, 'P', 'p')").run();
  });

  it('does nothing with a single local server', () => {
    addWindow(db, 'local', 'azito:0');
    run(db);
    expect(names(db)).toEqual(['local']);
    expect(aliases(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM windows').get()).toEqual({ n: 1 });
  });

  it('does not touch agent servers', () => {
    db.prepare("INSERT INTO servers (name, type, host, agent_port) VALUES ('box1', 'agent', 'h', 1), ('box2', 'agent', 'h', 1)").run();
    run(db);
    expect(names(db)).toEqual(['local', 'box1', 'box2']);
  });

  it('merges a misao-only duplicate: rows move, default_mux becomes misao, the old name is aliased', () => {
    addServer(db, 'local-misao', 'misao');
    const ref = JSON.stringify({ kind: 'misao', workspace: 'ws', window: 'w_X' });
    const win = addWindow(db, 'local-misao', 'ws:w_X', { muxRef: ref });
    db.prepare("INSERT INTO tasks (project_id, title, server_name) VALUES (1, 't', 'local-misao')").run();
    db.prepare("INSERT INTO agent_turns (task_id, kind, status, nonce, server_name) VALUES (1, 'phase', 'running', 'n', 'local-misao')").run();
    db.prepare("INSERT INTO supervisor_launches (launch_id, server_name, target, bootstrap_hash) VALUES ('l', 'local-misao', 'ws:w_X', 'h')").run();
    db.prepare("INSERT INTO browser_groups (group_id, server_name) VALUES ('g', 'local-misao')").run();
    db.prepare("INSERT INTO browser_tab_snapshots (server_name, group_id, tab_id, url, updated_at) VALUES ('local-misao', 'g', 't', 'u', 1)").run();
    db.prepare("INSERT INTO agent_watches (endpoint, server_name, target) VALUES ('e', 'local-misao', 'ws:w_X')").run();
    run(db);

    expect(names(db)).toEqual(['local']);
    expect(db.prepare("SELECT default_mux FROM servers WHERE name = 'local'").get()).toEqual({ default_mux: 'misao' });
    expect(aliases(db)).toEqual([{ old_name: 'local-misao', new_name: 'local' }]);
    expect(db.prepare('SELECT server_name FROM windows WHERE id = ?').get(win)).toEqual({ server_name: 'local' });
    for (const table of ['tasks', 'agent_turns', 'supervisor_launches', 'browser_groups', 'browser_tab_snapshots', 'agent_watches']) {
      expect(db.prepare(`SELECT DISTINCT server_name FROM ${table}`).all(), table).toEqual([{ server_name: 'local' }]);
    }
  });

  it('keeps the target project_servers row (working directory, tmux session) on a conflict and moves the rest', () => {
    addServer(db, 'local-misao', 'misao');
    db.prepare("INSERT INTO projects (id, name, slug) VALUES (2, 'Q', 'q')").run();
    db.prepare("INSERT INTO project_servers (project_id, server_name, working_directory, tmux_session) VALUES (1, 'local', '/a', 'sidekick'), (1, 'local-misao', '/b', 'azito'), (2, 'local-misao', '/c', 'azito')").run();
    run(db);
    expect(db.prepare('SELECT project_id AS p, server_name AS s, working_directory AS w, tmux_session AS t FROM project_servers ORDER BY project_id').all()).toEqual([
      { p: 1, s: 'local', w: '/a', t: 'sidekick' },
      { p: 2, s: 'local', w: '/c', t: 'azito' },
    ]);
  });

  it('drops a moved row that collides with the target\'s own unique row', () => {
    addServer(db, 'local-misao', 'misao');
    db.prepare("INSERT INTO agent_watches (endpoint, server_name, target) VALUES ('e', 'local', 't'), ('e', 'local-misao', 't')").run();
    db.prepare("INSERT INTO browser_groups (group_id, server_name) VALUES ('g', 'local'), ('g', 'local-misao')").run();
    run(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_watches').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM browser_groups').get()).toEqual({ n: 1 });
  });

  it('merges windows that name one physical window instead of failing, keeping the latest task\'s row', () => {
    addServer(db, 'local-misao', 'misao');
    db.prepare("INSERT INTO tasks (project_id, title) VALUES (1, 'a'), (1, 'b')").run();
    const plain = addWindow(db, 'local', 'azito:1');
    const taskRow = addWindow(db, 'local-misao', 'azito:1', { taskId: 2 });
    const otherRef = JSON.stringify({ kind: 'misao', workspace: 'ws', window: 'w_Y' });
    const refPlain = addWindow(db, 'local', 'x:0', { muxRef: otherRef });
    const refDup = addWindow(db, 'local-misao', 'ws:w_Y', { muxRef: otherRef });
    db.prepare("UPDATE tasks SET pending_operation_window_id = ? WHERE id = 1").run(plain);
    run(db);
    const ids = (db.prepare('SELECT id FROM windows ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toEqual([taskRow, refPlain]);
    expect(ids).not.toContain(refDup);
    expect(db.prepare('SELECT pending_operation_window_id AS w FROM tasks WHERE id = 1').get()).toEqual({ w: null });
    expect(db.prepare('SELECT DISTINCT server_name FROM windows').all()).toEqual([{ server_name: 'local' }]);
  });

  it('does not merge a tmux server on another socket (managed runtime)', () => {
    addServer(db, 'local-managed', 'tmux', 'managed');
    run(db);
    expect(names(db)).toEqual(['local', 'local-managed']);
    expect(aliases(db)).toEqual([]);
  });

  it('uses the tmux-default row as target even when a misao row came first, and repoints existing aliases', () => {
    db.prepare("UPDATE servers SET default_mux = 'misao' WHERE name = 'local'").run();
    addServer(db, 'local-tmux', 'tmux');
    db.prepare("INSERT INTO servers (name, type) VALUES ('gone', 'local')").run();
    run(db);
    expect(names(db)).toEqual(['local-tmux']);
    expect(db.prepare("SELECT default_mux FROM servers WHERE name = 'local-tmux'").get()).toEqual({ default_mux: 'misao' });
    expect(aliases(db)).toEqual([
      { old_name: 'gone', new_name: 'local-tmux' },
      { old_name: 'local', new_name: 'local-tmux' },
    ]);
  });

  it('is idempotent', () => {
    addServer(db, 'local-misao', 'misao');
    addWindow(db, 'local-misao', 'ws:w_X');
    run(db);
    run(db);
    expect(names(db)).toEqual(['local']);
    expect(aliases(db)).toEqual([{ old_name: 'local-misao', new_name: 'local' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM windows').get()).toEqual({ n: 1 });
  });
});
