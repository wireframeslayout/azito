import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './085_window_role';

describe('migration 085', () => {
  it('preserves columns, rows, indexes and window references on rebuild', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, slug TEXT);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY);
      CREATE TABLE windows (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_type TEXT NOT NULL CHECK (owner_type IN ('project', 'task')), project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, server_name TEXT NOT NULL, tmux_target TEXT NOT NULL, label TEXT, is_primary INTEGER NOT NULL DEFAULT 0, window_type TEXT NOT NULL DEFAULT 'terminal' CHECK (window_type IN ('terminal', 'agent')), worker_type TEXT, worker_model TEXT, agent_session_id TEXT, launch_command TEXT, working_directory TEXT, pane_layout TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), sleeping INTEGER NOT NULL DEFAULT 0, mux_ref TEXT, label_source TEXT NOT NULL DEFAULT 'auto' CHECK (label_source IN ('auto', 'user')), claude_config_dir TEXT, claude_pane_sessions TEXT, claude_config_dir_explicit INTEGER, CHECK ((owner_type='project' AND project_id IS NOT NULL AND task_id IS NULL) OR (owner_type='task' AND task_id IS NOT NULL)));
      INSERT INTO projects (id, name, slug) VALUES (1, 'Project', 'project');
      INSERT INTO windows (id, owner_type, project_id, server_name, tmux_target, window_type, mux_ref, label_source, claude_config_dir, claude_pane_sessions, claude_config_dir_explicit)
      VALUES (1, 'project', 1, 'local', 's:w', 'agent', 'ref', 'user', '/config', '{}', 1);
      INSERT INTO windows (id, owner_type, project_id, server_name, tmux_target) VALUES (100, 'project', 1, 'local', 's:deleted');
      DELETE FROM windows WHERE id=100;
      ALTER TABLE windows ADD COLUMN drift TEXT DEFAULT 'test';
      CREATE INDEX test_window_drift ON windows(drift);
      CREATE TABLE reference_test (window_id INTEGER REFERENCES windows(id) ON DELETE CASCADE);
      INSERT INTO reference_test VALUES (1);`);
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='windows' ORDER BY name").all();
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    db.transaction(() => up(db))();
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='windows' ORDER BY name").all()).toEqual(before);
    expect(db.prepare('SELECT id, mux_ref, label_source, claude_config_dir, claude_pane_sessions, claude_config_dir_explicit, drift, role, origin_project_id FROM windows').get()).toEqual({ id: 1, mux_ref: 'ref', label_source: 'user', claude_config_dir: '/config', claude_pane_sessions: '{}', claude_config_dir_explicit: 1, drift: 'test', role: null, origin_project_id: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const inserted = db.prepare("INSERT INTO windows (owner_type, server_name, tmux_target) VALUES ('server', 'local', 's:new')").run();
    expect(inserted.lastInsertRowid).toBe(101);
    expect(() => db.exec("UPDATE windows SET label_source='bad' WHERE id=1")).toThrow();
    expect(() => db.exec("UPDATE windows SET role='orchestrator' WHERE id=1")).toThrow();
    db.exec("UPDATE windows SET owner_type='server', project_id=NULL, role='orchestrator', origin_project_id=1 WHERE id=1");
    db.exec('DELETE FROM projects WHERE id=1');
    expect(db.prepare('SELECT origin_project_id FROM windows WHERE id=1').get()).toEqual({ origin_project_id: null });
    db.exec('DELETE FROM windows WHERE id=1');
    expect(db.prepare('SELECT * FROM reference_test').all()).toEqual([]);
    db.close();
  });
});
