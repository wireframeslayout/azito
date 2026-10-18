import path from 'path';
import fs from 'fs';
import os from 'os';
import { isReleaseMode, resolveRoot } from './releaseInfo';
import type { SecretFileGuard } from './os/secretFileGuard';

export interface DataPaths {
  dir: string;
  db: string;
  masterKey: string;
  vapidKeys: string;
  uiToken: string;
  webhookToken: string;
  browserProfile: string;
  sidekicks: string;
  updateState: string;
  updateLog: string;
  updateChannel: string;
}

// resolveDataDir() is called several times in one CLI process (the command and its helpers): announce the default once.
let announcedReleaseDefault = false;

/** Test hook: forget that the release-default notice was printed. */
export function _resetReleaseDefaultNotice(): void {
  announcedReleaseDefault = false;
}

export function resolveDataDir(guard: SecretFileGuard): DataPaths {
  const explicitDir = process.env.AZITO_DATA_DIR;

  if (explicitDir) {
    const dir = path.resolve(explicitDir);
    guard.ensureProtectedDir(dir);

    const sidekicks = process.env.AZITO_SIDEKICKS_DIR
      ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
      : path.join(dir, 'sidekicks');

    return {
      dir,
      db: path.join(dir, 'data.db'),
      masterKey: path.join(dir, 'master.key'),
      vapidKeys: path.join(dir, 'vapid-keys.json'),
      uiToken: path.join(dir, 'ui-token'),
      webhookToken: path.join(dir, 'webhook-token'),
      browserProfile: path.join(dir, 'browser-profile'),
      sidekicks,
      updateState: path.join(dir, 'update-state.json'),
      updateLog: path.join(dir, 'update.log'),
      updateChannel: path.join(dir, 'update-channel.json'),
    };
  }

  if (isReleaseMode()) {
    const dir = path.join(os.homedir(), '.azito', 'data');
    guard.ensureProtectedDir(dir);

    if (!announcedReleaseDefault) {
      announcedReleaseDefault = true;
      console.log(`AZITO_DATA_DIR not set, using ${dir} (release mode default)`);
    }

    const sidekicks = process.env.AZITO_SIDEKICKS_DIR
      ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
      : path.join(dir, 'sidekicks');

    return {
      dir,
      db: path.join(dir, 'data.db'),
      masterKey: path.join(dir, 'master.key'),
      vapidKeys: path.join(dir, 'vapid-keys.json'),
      uiToken: path.join(dir, 'ui-token'),
      webhookToken: path.join(dir, 'webhook-token'),
      browserProfile: path.join(dir, 'browser-profile'),
      sidekicks,
      updateState: path.join(dir, 'update-state.json'),
      updateLog: path.join(dir, 'update.log'),
      updateChannel: path.join(dir, 'update-channel.json'),
    };
  }

  const repoRoot = resolveRoot();
  const dataSubdir = path.join(repoRoot, 'data');
  guard.ensureProtectedDir(dataSubdir);
  const sidekicks = process.env.AZITO_SIDEKICKS_DIR
    ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
    : path.join(dataSubdir, 'sidekicks');

  return {
    dir: repoRoot,
    db: path.join(repoRoot, 'data.db'),
    masterKey: path.join(dataSubdir, 'master.key'),
    vapidKeys: path.join(dataSubdir, 'vapid-keys.json'),
    uiToken: path.join(dataSubdir, 'ui-token'),
    webhookToken: path.join(dataSubdir, 'webhook-token'),
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
