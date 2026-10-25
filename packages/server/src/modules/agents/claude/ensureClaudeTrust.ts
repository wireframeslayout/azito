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
 * The key Claude Code files a project under in `~/.claude.json` `projects`, for a path on a host of `platform`. Read from its code
 * (@anthropic-ai/claude-code 2.0.50 `cli.js`): the key of the directory it runs in is `path.normalize(<git rev-parse --show-toplevel>)`,
 * or `path.resolve(cwd)` outside a repository (`h_1`); the trust check looks that key up, then walks `path.resolve(dir, '..')`
 * from the cwd upwards (`EX`), and the accepted dialog writes under the first key (`bI`). On Windows `path` is `path.win32`: git
 * prints `C:/Users/me/repo`, and `normalize` turns it into `C:\Users\me\repo`; the parents are in the same backslash form.
 * So the key is the backslash path, without a trailing separator and without a `\\?\` prefix (neither is ever produced), and not
 * the forward-slash form. The keys are compared as they are (case included): the caller passes the directory in the spelling the
 * worker's own directory starts with. A Unix path is the key as it is.
 */
export function claudeProjectKey(platform: HostPlatform, projectPath: string): string {
  if (platform !== 'win32') return projectPath;
  const normalized = path.win32.normalize(projectPath.replace(/^\\\\\?\\/, ''));
  const root = path.win32.parse(normalized).root;
  return root + normalized.slice(root.length).replace(/\\+$/, '');
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
  return configLocks.withLock(configPath, () => registerTrust(ops, configPath, claudeProjectKey(ops.platform, projectPath)));
}

async function registerTrust(ops: IFileOps, configPath: string, projectKey: string): Promise<EnsureClaudeTrustResult> {
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

  const existing = config.projects?.[projectKey];
  if (existing?.hasTrustDialogAccepted === true) return { action: 'already_trusted' };

  const updated = {
    ...config,
    projects: { ...config.projects, [projectKey]: { ...existing, hasTrustDialogAccepted: true } },
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
