import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';

/** The file's real path, or the path itself when nothing is there (or the link dangles). */
export async function realpathOrSelf(ops: IFileOps, filePath: string): Promise<string> {
  try {
    return await ops.realpath(filePath);
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'NOT_FOUND') return filePath;
    throw err;
  }
}

/**
 * The real path of the host's `~/.claude.json` (a symbolic link, as kept by a dotfiles manager, is followed: the file operations refuse to
 * write through one). It is also the key of `configLocks`, so every writer of the file takes the same lock whichever spelling it came by.
 */
export async function resolveClaudeConfigPath(ops: IFileOps): Promise<string> {
  return realpathOrSelf(ops, pathApiFor(ops.platform).join(await ops.realpath('~'), '.claude.json'));
}
