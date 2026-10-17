import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './Database';

describe('openDatabase freshLocalDefaultMux', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-fresh-mux-'));
    dbPath = path.join(dir, 'data.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function localDefaultMux(): string {
    const db = openDatabase(dbPath);
    try {
      return (db.prepare("SELECT default_mux AS mux FROM servers WHERE name = 'local'").get() as { mux: string }).mux;
    } finally {
      db.close();
    }
  }

  it('starts the seeded local server on the requested mux in a brand-new database', () => {
    openDatabase(dbPath, { freshLocalDefaultMux: 'misao' }).close();
    expect(localDefaultMux()).toBe('misao');
  });

  it('keeps tmux when no mux is requested', () => {
    openDatabase(dbPath).close();
    expect(localDefaultMux()).toBe('tmux');
  });

  it('never changes a database that already exists, whatever is requested', () => {
    openDatabase(dbPath).close();
    openDatabase(dbPath, { freshLocalDefaultMux: 'misao' }).close();
    expect(localDefaultMux()).toBe('tmux');
  });

  it('leaves a choice the user made alone on later starts', () => {
    openDatabase(dbPath, { freshLocalDefaultMux: 'misao' }).close();
    const db = openDatabase(dbPath, { freshLocalDefaultMux: 'misao' });
    db.prepare("UPDATE servers SET default_mux = 'tmux' WHERE name = 'local'").run();
    db.close();
    openDatabase(dbPath, { freshLocalDefaultMux: 'misao' }).close();
    expect(localDefaultMux()).toBe('tmux');
  });
});
