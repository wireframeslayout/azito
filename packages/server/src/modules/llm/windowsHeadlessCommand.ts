import { promises as fs } from 'fs';
import { win32 as path } from 'path';
import { isFullyQualified } from '../../shared/exec/windowsGit';

export interface CliSearchDetails { directories: string[]; extensions: string[] }
const DEFAULT_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD'];
export class UnsafeShimArgumentError extends Error {}
const UNSAFE = /[%^&|<>"!()\r\n]/;

/**
 * A candidate that cannot be stat'ed (missing, or in a PATH directory this user cannot read: EACCES / EPERM, an offline share)
 * is not a program this process can start, so the search goes on with the next one, as Windows' own PATH search does
 * (and `GitLocator` in `shared/exec/windowsGit.ts`). Stopping on it would hide a CLI that sits in a later directory.
 */
async function isExistingFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

export async function findWindowsHeadlessCommand(binary: string, env: NodeJS.ProcessEnv, isFile: (file: string) => Promise<boolean> = isExistingFile): Promise<{ file: string | null; search: CliSearchDetails }> {
  const directories = (env.PATH ?? '').split(';').map(p => p.trim().replace(/^"(.*)"$/, '$1')).filter(isFullyQualified);
  const extensions = (!env.PATHEXT?.trim() ? DEFAULT_EXTENSIONS : env.PATHEXT.split(';')).map(e => e.trim()).filter(e => /^\.(exe|com|cmd|bat)$/i.test(e));
  const search = { directories, extensions };
  for (const directory of directories) for (const extension of extensions) {
    const file = path.join(directory, binary + extension);
    if (await isFile(file)) return { file, search };
  }
  return { file: null, search };
}

export function windowsShimCommand(file: string, args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (/[%!"\r\n]/.test(file) || args.some(word => UNSAFE.test(word))) throw new UnsafeShimArgumentError('Unsafe cmd.exe argument');
  const command = env.ComSpec;
  const systemRoot = env.SystemRoot;
  const cmd = command && isFullyQualified(command) && path.basename(command).toLowerCase() === 'cmd.exe' ? command : systemRoot && isFullyQualified(systemRoot) ? path.join(systemRoot, 'System32', 'cmd.exe') : undefined;
  if (!cmd) throw new Error('cmd.exe not available');
  return { command: cmd, args: ['/d', '/s', '/c', `"${[file, ...args].map(word => `"${word.replace(/\\+$/, suffix => suffix + suffix)}"`).join(' ')}"`] };
}
