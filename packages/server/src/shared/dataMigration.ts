import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { DataPaths, LegacyPaths } from './dataDir';

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function copyFileSecure(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
}

function copyDirRecursiveSecure(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSecure(srcPath, destPath);
    } else {
      copyFileSecure(srcPath, destPath);
    }
  }
}

function rmRecursive(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function removeFiles(filePaths: string[]): void {
  for (const p of filePaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

export function migrateDataIfNeeded(paths: DataPaths, legacy: LegacyPaths): void {
  if (paths.db === legacy.db && paths.masterKey === legacy.masterKey) return;

  const newDbExists = exists(paths.db);
  const newKeyExists = exists(paths.masterKey);
  const oldDbExists = exists(legacy.db);
  const oldKeyExists = exists(legacy.masterKey);

  if (newDbExists && newKeyExists) return;

  if (newDbExists && !newKeyExists && oldKeyExists) {
    console.error(
      `[data-migration] Fatal: data.db exists at ${paths.db} but master.key is missing. ` +
      `The old master.key exists at ${legacy.masterKey}. ` +
      `This split state would make encrypted columns unrecoverable. ` +
      `Manually copy master.key to ${paths.masterKey} or remove data.db to start fresh.`,
    );
    process.exit(1);
  }

  if (!newDbExists && newKeyExists && oldDbExists) {
    console.error(
      `[data-migration] Fatal: master.key exists at ${paths.masterKey} but data.db is missing. ` +
      `The old data.db exists at ${legacy.db}. ` +
      `This split state would make encrypted columns unrecoverable. ` +
      `Manually copy data.db (with -wal/-shm) to ${paths.db} or remove master.key to start fresh.`,
    );
    process.exit(1);
  }

  if (!oldDbExists && !oldKeyExists) return;

  // Only one of db/key exists at legacy location — partial legacy state, nothing to migrate
  if (!oldDbExists || !oldKeyExists) return;

  console.log('[data-migration] Migrating persistent data to new location...');

  const stagingDir = path.join(paths.dir, `.migrating-${process.pid}`);
  try {
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

    let sourceDb: InstanceType<typeof Database> | null = null;
    try {
      sourceDb = new Database(legacy.db, { readonly: false });
      sourceDb.pragma('locking_mode = EXCLUSIVE');
      sourceDb.exec('BEGIN EXCLUSIVE');
      sourceDb.exec('COMMIT');
    } catch {
      console.error(
        `[data-migration] Cannot acquire exclusive lock on ${legacy.db}. ` +
        `Is another AZITO instance running? Migration aborted.`,
      );
      rmRecursive(stagingDir);
      process.exit(1);
    }

    try {
      sourceDb!.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.error(
        `[data-migration] WAL checkpoint failed on ${legacy.db}: ${(err as Error).message}. ` +
        `The database may be in an inconsistent state. Migration aborted.`,
      );
      try { sourceDb!.close(); } catch {}
      rmRecursive(stagingDir);
      process.exit(1);
    }

    try {
      copyFileSecure(legacy.db, path.join(stagingDir, 'data.db'));
      for (const suffix of ['-wal', '-shm']) {
        const src = `${legacy.db}${suffix}`;
        if (exists(src)) {
          copyFileSecure(src, path.join(stagingDir, `data.db${suffix}`));
        }
      }

      copyFileSecure(legacy.masterKey, path.join(stagingDir, 'master.key'));

      if (exists(legacy.vapidKeys)) {
        copyFileSecure(legacy.vapidKeys, path.join(stagingDir, 'vapid-keys.json'));
        console.log(`[data-migration]   vapid-keys.json copied`);
      } else {
        console.warn(`[data-migration]   vapid-keys.json not found at ${legacy.vapidKeys} (will be regenerated)`);
      }

      if (exists(legacy.browserProfile)) {
        copyDirRecursiveSecure(legacy.browserProfile, path.join(stagingDir, 'browser-profile'));
        console.log(`[data-migration]   browser-profile/ copied`);
      } else {
        console.warn(`[data-migration]   browser-profile/ not found at ${legacy.browserProfile} (will be recreated on use)`);
      }
    } catch (err) {
      rmRecursive(stagingDir);
      throw err;
    } finally {
      if (sourceDb) {
        try { sourceDb.close(); } catch {}
      }
    }

    const movedPaths: string[] = [];
    try {
      for (const name of fs.readdirSync(stagingDir)) {
        const src = path.join(stagingDir, name);
        const dest = path.join(paths.dir, name);
        fs.renameSync(src, dest);
        movedPaths.push(dest);
      }
    } catch (err) {
      removeFiles(movedPaths);
      rmRecursive(stagingDir);
      throw err;
    }

    rmRecursive(stagingDir);

    console.log(`[data-migration] Migration complete. Data now at ${paths.dir}`);
    console.log(`[data-migration] Old files at ${path.dirname(legacy.masterKey)} are preserved for rollback.`);

  } catch (err) {
    rmRecursive(stagingDir);
    console.error(`[data-migration] Migration failed:`, err);
    process.exit(1);
  }
}
