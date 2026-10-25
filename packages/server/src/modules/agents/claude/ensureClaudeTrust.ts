import { createHash } from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import path from 'node:path';
import { pathApiFor } from '../../../shared/os/hostPath';
import type { HostPlatform } from '../../../shared/os/hostEnv';
import { KeyedMutex } from '../../../shared/keyedMutex';

/** Two projects registering at once would each read the same file and the later write would drop the earlier registration. */
const configLocks = new KeyedMutex();

export type EnsureClaudeTrustResult =
  | { action: 'registered' }
  | { action: 'already_trusted' }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; reason: string };

/**
 * The keys Claude Code may file a project under in `~/.claude.json` `projects`, for a path on a host of `platform`.
 *  - A Unix path is the key as it is.
 *  - On Windows the spelling depends on the version, so both are written:
 *    2.1.x (native 2.1.310, `wq`): `path.normalize(path)` with every `\` turned into `/`, used for the current directory's key, the
 *    trust lookup and the write of an accepted dialog alike, so `C:/Users/me/repo`;
 *    2.0.x (`cli.js` 2.0.50, `h_1` / `EX` / `bI`): `path.normalize(...)`, which is the backslash form `C:\Users\me\repo`.
 * Neither form has a trailing separator or a `\\?\` prefix (neither is ever produced). Keys are compared as they are, case included: the
 * caller passes the directory in the spelling the worker's own directory starts with.
 */
export function claudeProjectKeys(platform: HostPlatform, projectPath: string): string[] {
  if (platform !== 'win32') return [projectPath];
  const normalized = path.win32.normalize(projectPath.replace(/^\\\\\?\\/, ''));
  const root = path.win32.parse(normalized).root;
  const backslash = root + normalized.slice(root.length).replace(/\\+$/, '');
  return [backslash.replaceAll('\\', '/'), backslash];
}

/**
 * Marks `projectPath` as trusted in the server host's `~/.claude.json`, so Claude Code does not stop at its trust dialog.
 * The file is read and replaced through the host's file operations: the replace is atomic and keeps the file's permission bits
 * (the file holds credentials), and it is refused if the file changed between the read and the write.
 */
export async function ensureClaudeTrust(transport: IServerTransport, projectPath: string): Promise<EnsureClaudeTrustResult> {
  const ops = transport.files();
  const configPath = pathApiFor(ops.platform).join(await ops.realpath('~'), '.claude.json');
  // The whole read, update and save of one config file is one step for this process; the write's own check
  // (the hash of what was read) is the guard against anything else that changes the file.
  return configLocks.withLock(configPath, () => registerTrust(ops, configPath, claudeProjectKeys(ops.platform, projectPath)));
}

async function registerTrust(ops: IFileOps, configPath: string, projectKeys: string[]): Promise<EnsureClaudeTrustResult> {
  let raw: Buffer;
  try {
    raw = (await ops.read(configPath)).data;
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'NOT_FOUND') return { action: 'skipped', reason: '~/.claude.json not found' };
    throw err;
  }

  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return { action: 'failed', reason: `~/.claude.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const missing = projectKeys.filter((key) => config.projects?.[key]?.hasTrustDialogAccepted !== true);
  if (missing.length === 0) return { action: 'already_trusted' };

  const updated = {
    ...config,
    projects: {
      ...config.projects,
      ...Object.fromEntries(missing.map((key) => [key, { ...config.projects?.[key], hasTrustDialogAccepted: true }])),
    },
  };
  try {
    await ops.write(configPath, Buffer.from(JSON.stringify(updated, null, 2), 'utf8'), {
      expect: { sha256: createHash('sha256').update(raw).digest('hex') },
    });
  } catch (err) {
    if (err instanceof FileOpsError) return { action: 'failed', reason: `atomic write failed: ${err.message}` };
    throw err;
  }
  return { action: 'registered' };
}
