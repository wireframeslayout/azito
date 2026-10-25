import { createHash } from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { configLocks } from './ensureClaudeTrust';

/** Two tasks starting at once would each read the same file and the later write would drop the earlier change. */
const settingsLocks = new KeyedMutex();

/**
 * The key Claude Code (2.1.x, `BypassPermissionsModeDialog`) writes to the `userSettings` source (`~/.claude/settings.json`) when
 * "Yes, I accept" is chosen in the "Bypass Permissions mode" dialog, and the key it checks before showing that dialog.
 */
const SKIP_DIALOG_KEY = 'skipDangerousModePermissionPrompt';

/**
 * What Claude Code 2.0.x keeps in the global config `~/.claude.json` instead (`cli.js` 2.0.50 sets it on accept and shows the dialog while it is
 * unset; it does not read the key above). 2.1.x moves it on start (`tengu_migrate_bypass_permissions_accepted`: it writes
 * `skipDangerousModePermissionPrompt` to the user settings, then removes this key), so setting it is harmless there.
 */
const LEGACY_ACCEPTED_KEY = 'bypassPermissionsModeAccepted';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export type EnsureClaudeBypassAcceptedResult =
  | { action: 'accepted' }
  | { action: 'already_accepted' }
  | { action: 'skipped'; reason: string };

/**
 * Accepts, in the server host's `~/.claude/settings.json`, the "Bypass Permissions mode" dialog that `claude --dangerously-skip-permissions`
 * shows on a host where it has not run before; otherwise the first task stops at the dialog. Other keys are kept.
 * A missing file (or `~/.claude` directory) is created, exclusively, with only this key: a file that appears meanwhile is never overwritten
 * (the write is refused if it is no longer the empty file just created; the failure is thrown for the caller to log). An existing file is
 * read and replaced guarded by the hash of what was read, through its real path (a symbolic link is written through to its target).
 * Where the host's file operations replace atomically and keep permission bits (POSIX) so does this; on Windows an existing file is written in
 * place (the ACL is kept), which is not atomic. A file that is not a JSON object is left untouched.
 */
export async function ensureClaudeBypassAccepted(transport: IServerTransport): Promise<EnsureClaudeBypassAcceptedResult> {
  const ops = transport.files();
  const api = pathApiFor(ops.platform);
  const claudeDir = api.join(await ops.realpath('~'), '.claude');
  const settingsPath = await realpathOrSelf(ops, api.join(claudeDir, 'settings.json'));
  return settingsLocks.withLock(settingsPath, () =>
    setTrueKey(ops, settingsPath, SKIP_DIALOG_KEY, '~/.claude/settings.json', { createDirectory: api.dirname(settingsPath) }),
  );
}

/**
 * The same acceptance for Claude Code 2.0.x: `bypassPermissionsModeAccepted: true` in `~/.claude.json`. That file is `ensureClaudeTrust`'s, so
 * it takes the same lock on the same path, and a missing file is skipped (Claude Code creates it itself).
 */
export async function ensureClaudeLegacyBypassAccepted(transport: IServerTransport): Promise<EnsureClaudeBypassAcceptedResult> {
  const ops = transport.files();
  const configPath = pathApiFor(ops.platform).join(await ops.realpath('~'), '.claude.json');
  return configLocks.withLock(configPath, () => setTrueKey(ops, configPath, LEGACY_ACCEPTED_KEY, '~/.claude.json', null));
}

/** The file's real path, or the path itself when nothing is there (or the link dangles). */
async function realpathOrSelf(ops: IFileOps, filePath: string): Promise<string> {
  try {
    return await ops.realpath(filePath);
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'NOT_FOUND') return filePath;
    throw err;
  }
}

/** `create`: where a missing file is made (its directory is created too); null: a missing file is skipped. */
async function setTrueKey(
  ops: IFileOps,
  filePath: string,
  key: string,
  label: string,
  create: { createDirectory: string } | null,
): Promise<EnsureClaudeBypassAcceptedResult> {
  let raw: Buffer;
  try {
    raw = (await ops.read(filePath)).data;
  } catch (err) {
    if (!(err instanceof FileOpsError) || err.code !== 'NOT_FOUND') throw err;
    if (!create) return { action: 'skipped', reason: `${label} not found` };
    const created = await createWithKey(ops, filePath, key, create.createDirectory);
    // Somebody made the file after it was read: it is read again and its content kept (a file that still cannot be read is skipped).
    return created ?? setTrueKey(ops, filePath, key, label, null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return { action: 'skipped', reason: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { action: 'skipped', reason: `${label} is not a JSON object` };
  }
  if ((parsed as Record<string, unknown>)[key] === true) return { action: 'already_accepted' };

  await writeJson(ops, filePath, { ...parsed, [key]: true }, createHash('sha256').update(raw).digest('hex'));
  return { action: 'accepted' };
}

/**
 * Makes the file as an empty one that must not exist yet, then fills it, guarded by the empty content's hash. A writer that got there
 * first is never overwritten: null when the file exists already (the caller reads it again); an error is thrown when it was filled meanwhile,
 * with the file left as that writer made it.
 */
async function createWithKey(ops: IFileOps, filePath: string, key: string, directory: string): Promise<EnsureClaudeBypassAcceptedResult | null> {
  await ops.create(directory, 'directory', { recursive: true });
  try {
    await ops.create(filePath, 'file');
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'ALREADY_EXISTS') return null;
    throw err;
  }
  try {
    await writeJson(ops, filePath, { [key]: true }, EMPTY_SHA256);
  } catch (err) {
    // An empty settings file is not a valid one: take back what was just made, unless somebody else's content is there now.
    if (!(err instanceof FileOpsError && err.code === 'CONFLICT')) await ops.remove(filePath).catch(() => undefined);
    throw err;
  }
  return { action: 'accepted' };
}

async function writeJson(ops: IFileOps, filePath: string, content: Record<string, unknown>, expectedSha256: string): Promise<void> {
  await ops.write(filePath, Buffer.from(JSON.stringify(content, null, 2), 'utf8'), { expect: { sha256: expectedSha256 } });
}
