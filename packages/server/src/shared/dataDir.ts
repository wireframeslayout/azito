import path from 'path';
import fs from 'fs';
import os from 'os';
import { isReleaseMode, resolveRoot } from './releaseInfo';

export interface DataPaths {
  dir: string;
  db: string;
  masterKey: string;
  vapidKeys: string;
  uiToken: string;
  browserProfile: string;
  sidekicks: string;
  updateState: string;
  updateLog: string;
  updateChannel: string;
}

export function resolveDataDir(): DataPaths {
  const explicitDir = process.env.AZITO_DATA_DIR;

  if (explicitDir) {
    const dir = path.resolve(explicitDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}

    const sidekicks = process.env.AZITO_SIDEKICKS_DIR
      ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
      : path.join(dir, 'sidekicks');

    return {
      dir,
      db: path.join(dir, 'data.db'),
      masterKey: path.join(dir, 'master.key'),
      vapidKeys: path.join(dir, 'vapid-keys.json'),
      uiToken: path.join(dir, 'ui-token'),
      browserProfile: path.join(dir, 'browser-profile'),
      sidekicks,
      updateState: path.join(dir, 'update-state.json'),
      updateLog: path.join(dir, 'update.log'),
      updateChannel: path.join(dir, 'update-channel.json'),
    };
  }

  if (isReleaseMode()) {
    const dir = path.join(os.homedir(), '.azito', 'data');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}

    console.log(`AZITO_DATA_DIR not set, using ${dir} (release mode default)`);

    const sidekicks = process.env.AZITO_SIDEKICKS_DIR
      ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
      : path.join(dir, 'sidekicks');

    return {
      dir,
      db: path.join(dir, 'data.db'),
      masterKey: path.join(dir, 'master.key'),
      vapidKeys: path.join(dir, 'vapid-keys.json'),
      uiToken: path.join(dir, 'ui-token'),
      browserProfile: path.join(dir, 'browser-profile'),
      sidekicks,
      updateState: path.join(dir, 'update-state.json'),
      updateLog: path.join(dir, 'update.log'),
      updateChannel: path.join(dir, 'update-channel.json'),
    };
  }

  const repoRoot = resolveRoot();
  const dataSubdir = path.join(repoRoot, 'data');
  const sidekicks = process.env.AZITO_SIDEKICKS_DIR
    ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
    : path.join(dataSubdir, 'sidekicks');

  return {
    dir: repoRoot,
    db: path.join(repoRoot, 'data.db'),
    masterKey: path.join(dataSubdir, 'master.key'),
    vapidKeys: path.join(dataSubdir, 'vapid-keys.json'),
    uiToken: path.join(dataSubdir, 'ui-token'),
    browserProfile: path.join(dataSubdir, 'browser-profile'),
    sidekicks,
    updateState: path.join(dataSubdir, 'update-state.json'),
    updateLog: path.join(dataSubdir, 'update.log'),
    updateChannel: path.join(dataSubdir, 'update-channel.json'),
  };
}

export interface LegacyPaths {
  db: string;
  masterKey: string;
  vapidKeys: string;
  browserProfile: string;
}

export function getLegacyPaths(): LegacyPaths {
  const repoRoot = resolveRoot();
  const dataSubdir = path.join(repoRoot, 'data');
  return {
    db: path.join(repoRoot, 'data.db'),
    masterKey: path.join(dataSubdir, 'master.key'),
    vapidKeys: path.join(dataSubdir, 'vapid-keys.json'),
    browserProfile: path.join(dataSubdir, 'browser-profile'),
  };
}
