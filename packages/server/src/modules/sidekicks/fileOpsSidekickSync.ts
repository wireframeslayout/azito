import * as crypto from 'crypto';
import { buildCommandSpec, CommandError } from '../../shared/exec/commandSpec';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor, type HostPathApi } from '../../shared/os/hostPath';
import { HASH_FILENAME, LOCK_STALE_MS, type SidekickSyncContext } from './sidekickSyncShared';

const EXTRACT_TIMEOUT_MS = 120_000;
const HASH_READ_LIMIT_BYTES = 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCode(err: unknown, code: FileOpsError['code']): boolean {
  return err instanceof FileOpsError && err.code === code;
}

/** Removes `path` unless it is already gone. */
async function removeIfPresent(files: IFileOps, path: string): Promise<void> {
  try {
    await files.remove(path);
  } catch (err) {
    if (!isCode(err, 'NOT_FOUND')) throw err;
  }
}

/** Where the sync keeps its files on the host: all of them next to each other under `~/.azito`. */
interface HostLayout {
  azitoDir: string;
  base: string;
  lockDir: string;
  payload: string;
  staging: string;
  /** The same two, relative to `azitoDir`: `tar` runs there so that no drive letter or backslash reaches its arguments. */
  payloadName: string;
  stagingName: string;
}

function layoutFor(api: HostPathApi, home: string, nonce: string): HostLayout {
  const azitoDir = api.join(home, '.azito');
  const payloadName = `sidekicks-payload.${nonce}.tar.gz`;
  const stagingName = `sidekicks.tmp.${nonce}`;
  return {
    azitoDir,
    base: api.join(azitoDir, 'sidekicks'),
    lockDir: api.join(azitoDir, 'sidekicks.lock'),
    payload: api.join(azitoDir, payloadName),
    staging: api.join(azitoDir, stagingName),
    payloadName,
    stagingName,
  };
}

/**
 * The sync on a host that has file operations (`IFileOps`) and `run` (every agent whose OS is recorded, and the hub's own
 * files): the tarball is written as a file, `tar` extracts it into a staging directory, and the staging directory replaces
 * the live tree last, so a failed transfer never destroys a previously good tree. No shell is involved; failure is an
 * exception, not a marker in the output.
 */
export async function syncThroughFileOps(ctx: SidekickSyncContext): Promise<void> {
  const files = ctx.transport.files();
  const api = pathApiFor(files.platform);
  const nonce = crypto.randomBytes(6).toString('hex');
  const layout = layoutFor(api, await files.realpath('~'), nonce);
  await files.create(layout.azitoDir, 'directory', { recursive: true });

  if (await readRemoteHash(files, api.join(layout.base, HASH_FILENAME)) === ctx.hash) return;

  await acquireLock(ctx, files, layout.lockDir);
  try {
    try {
      await files.write(layout.payload, await ctx.buildTarball());
      await files.create(layout.staging, 'directory');
      await extract(ctx, layout);
      await files.write(api.join(layout.staging, HASH_FILENAME), Buffer.from(`${ctx.hash}\n`));
      await removeIfPresent(files, layout.payload);
      await removeIfPresent(files, layout.base);
      await files.rename(layout.staging, layout.base);
    } catch (err) {
      // Best-effort cleanup of the staging artifacts; the live tree (if any) is untouched because the swap is the last step.
      await Promise.all([layout.payload, layout.staging].map((path) => removeIfPresent(files, path).catch(() => undefined)));
      throw err;
    }
  } finally {
    await removeIfPresent(files, layout.lockDir).catch(() => undefined);
  }
}

async function readRemoteHash(files: IFileOps, hashFile: string): Promise<string | null> {
  try {
    const value = (await files.read(hashFile, { maxBytes: HASH_READ_LIMIT_BYTES })).data.toString('utf8').trim();
    return value || null;
  } catch (err) {
    if (isCode(err, 'NOT_FOUND')) return null;
    throw err;
  }
}

/**
 * Creating a directory is atomic, so it is the lock. A lock directory older than LOCK_STALE_MS belongs to a holder that
 * died: it is removed and taken over. The age is the directory's mtime against this clock, so a host whose clock is far off
 * sees a lock as younger or older than it is.
 */
async function acquireLock(ctx: SidekickSyncContext, files: IFileOps, lockDir: string): Promise<void> {
  for (let attempt = 0; attempt < ctx.lockRetries; attempt++) {
    if (await tryCreateLock(files, lockDir)) return;
    if (attempt < ctx.lockRetries - 1) await sleep(ctx.lockRetryDelayMs);
  }
  throw new Error(
    `Sidekick sync to server "${ctx.serverName}" failed: could not acquire remote lock ${lockDir} after ${ctx.lockRetries} attempts (another sync in progress?)`,
  );
}

async function tryCreateLock(files: IFileOps, lockDir: string): Promise<boolean> {
  try {
    await files.create(lockDir, 'directory');
    return true;
  } catch (err) {
    if (!isCode(err, 'ALREADY_EXISTS')) throw err;
  }
  const held = await files.stat(lockDir, { followLinks: false });
  if (held && Date.now() - held.mtimeMs <= LOCK_STALE_MS) return false;
  await removeIfPresent(files, lockDir);
  try {
    await files.create(lockDir, 'directory');
    return true;
  } catch (err) {
    if (isCode(err, 'ALREADY_EXISTS')) return false;
    throw err;
  }
}

/**
 * `tar` runs in `~/.azito` with both paths relative: that works for any `tar` on the host's PATH (the Windows one in System32,
 * or a GNU tar that reads `C:` as a remote host name) without having to name where it is installed.
 */
async function extract(ctx: SidekickSyncContext, layout: HostLayout): Promise<void> {
  const spec = buildCommandSpec('tar', ['xzf', layout.payloadName, '-C', layout.stagingName], { cwd: layout.azitoDir, timeoutMs: EXTRACT_TIMEOUT_MS });
  const failure = (detail: string): Error => new Error(`Sidekick sync to server "${ctx.serverName}" failed (extract): ${detail}`);
  let result;
  try {
    result = await ctx.transport.run(spec);
  } catch (err) {
    if (err instanceof CommandError) throw failure(err.message);
    throw err;
  }
  if (result.exitCode !== 0) throw failure([result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' | ') || `exit ${result.exitCode}`);
}
