import { createHash } from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';
import { KeyedMutex } from '../../../shared/keyedMutex';

/** Two tasks starting at once would each read the same file and the later write would drop the earlier change. */
const settingsLocks = new KeyedMutex();

/**
 * The key Claude Code (2.1.x, `BypassPermissionsModeDialog`) writes to the `userSettings` source (`~/.claude/settings.json`) when
 * "Yes, I accept" is chosen in the "Bypass Permissions mode" dialog, and the key it checks before showing that dialog.
 */
const SKIP_DIALOG_KEY = 'skipDangerousModePermissionPrompt';

export type EnsureClaudeBypassAcceptedResult =
  | { action: 'accepted' }
  | { action: 'already_accepted' }
  | { action: 'skipped'; reason: string };

/**
 * Accepts, in the server host's `~/.claude/settings.json`, the "Bypass Permissions mode" dialog that `claude --dangerously-skip-permissions`
 * shows on a host where it has not run before; otherwise the first task stops at the dialog. Other keys are kept. A missing file (or
 * `~/.claude` directory) is created with only this key. The file is read and replaced through the host's file operations (atomic, permission
 * bits kept, refused if the file changed between the read and the write); a file that is not a JSON object is left untouched.
 */
export async function ensureClaudeBypassAccepted(transport: IServerTransport): Promise<EnsureClaudeBypassAcceptedResult> {
  const ops = transport.files();
  const api = pathApiFor(ops.platform);
  const claudeDir = api.join(await ops.realpath('~'), '.claude');
  const settingsPath = api.join(claudeDir, 'settings.json');
  return settingsLocks.withLock(settingsPath, () => acceptBypass(ops, claudeDir, settingsPath));
}

async function acceptBypass(ops: IFileOps, claudeDir: string, settingsPath: string): Promise<EnsureClaudeBypassAcceptedResult> {
  let raw: Buffer;
  try {
    raw = (await ops.read(settingsPath)).data;
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'NOT_FOUND') {
      await ops.create(claudeDir, 'directory', { recursive: true });
      await write(ops, settingsPath, { [SKIP_DIALOG_KEY]: true });
      return { action: 'accepted' };
    }
    throw err;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return { action: 'skipped', reason: `~/.claude/settings.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { action: 'skipped', reason: '~/.claude/settings.json is not a JSON object' };
  }
  if ((settings as Record<string, unknown>)[SKIP_DIALOG_KEY] === true) return { action: 'already_accepted' };

  await write(ops, settingsPath, { ...settings, [SKIP_DIALOG_KEY]: true }, createHash('sha256').update(raw).digest('hex'));
  return { action: 'accepted' };
}

async function write(ops: IFileOps, settingsPath: string, content: Record<string, unknown>, expectedSha256?: string): Promise<void> {
  await ops.write(settingsPath, Buffer.from(JSON.stringify(content, null, 2), 'utf8'), expectedSha256 ? { expect: { sha256: expectedSha256 } } : undefined);
}
