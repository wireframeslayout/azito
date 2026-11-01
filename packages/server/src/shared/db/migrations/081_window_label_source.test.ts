import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './081_window_label_source';

describe('window label source migration', () => {
  it('marks existing and new labels auto and rejects invalid sources', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE windows (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO windows (label) VALUES ('existing')");
    up(db);
    db.exec("INSERT INTO windows (label) VALUES ('new')");
    expect(db.prepare('SELECT label_source FROM windows ORDER BY id').all()).toEqual([{ label_source: 'auto' }, { label_source: 'auto' }]);
    expect(() => db.exec("UPDATE windows SET label_source = 'other'")).toThrow();
    db.close();
  });
});
