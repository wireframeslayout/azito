import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './086_window_links';

describe('migration 086', () => {
  it('enforces target and pair constraints and cascades deletions', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE windows (id INTEGER PRIMARY KEY); CREATE TABLE tasks (id INTEGER PRIMARY KEY); INSERT INTO windows VALUES (1), (2), (3); INSERT INTO tasks VALUES (1)');
    up(db);
    const add = db.prepare("INSERT INTO window_links (source_window_id, target_window_id, task_id, kind, source) VALUES (?, ?, ?, 'orchestration', 'manual')");
    add.run(1, 2, null);
    add.run(1, null, 1);
    expect(() => add.run(1, 2, null)).toThrow();
    expect(() => add.run(1, null, 1)).toThrow();
    expect(() => add.run(1, null, null)).toThrow();
    expect(() => add.run(1, 2, 1)).toThrow();
    expect(() => add.run(1, 1, null)).toThrow();
    db.exec('DELETE FROM windows WHERE id=2');
    expect(db.prepare('SELECT count(*) AS n FROM window_links').get()).toEqual({ n: 1 });
    db.exec('DELETE FROM tasks WHERE id=1');
    expect(db.prepare('SELECT count(*) AS n FROM window_links').get()).toEqual({ n: 0 });
    add.run(1, 3, null);
    db.exec('DELETE FROM windows WHERE id=1');
    expect(db.prepare('SELECT count(*) AS n FROM window_links').get()).toEqual({ n: 0 });
    db.close();
  });
});
