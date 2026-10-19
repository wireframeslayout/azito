import { createHash } from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { FileOpsError } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';

export type EnsureClaudeTrustResult =
  | { action: 'registered' }
  | { action: 'already_trusted' }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; reason: string };

/**
 * Marks `projectPath` as trusted in the server host's `~/.claude.json`, so Claude Code does not stop at its trust dialog.
 * The file is read and replaced through the host's file operations: the replace is atomic and keeps the file's permission bits
 * (the file holds credentials), and it is refused if the file changed between the read and the write.
 */
export async function ensureClaudeTrust(transport: IServerTransport, projectPath: string): Promise<EnsureClaudeTrustResult> {
  const ops = transport.files();
  const configPath = pathApiFor(ops.platform).join(await ops.realpath('~'), '.claude.json');

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

  const existing = config.projects?.[projectPath];
  if (existing?.hasTrustDialogAccepted === true) return { action: 'already_trusted' };

  const updated = {
    ...config,
    projects: { ...config.projects, [projectPath]: { ...existing, hasTrustDialogAccepted: true } },
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
