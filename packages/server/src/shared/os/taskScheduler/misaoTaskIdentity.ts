import * as path from 'path';
import { legacyMisaoTaskArgumentsOf, misaoTaskArgumentsOf } from './misaoTaskArguments';
import type { TaskExecAction } from './taskXmlRead';

const RELEASE_NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The release folder the misao task runs when `action` is exactly what the install writes for the misao in `root`: one program,
 * `conhost.exe`, and an arguments line equal to `misaoTaskArgumentsOf` (the very function that writes it) for `<root>\<version>\misao.exe`,
 * the log in `root` and the pipe made from `root` and the user. The version is the one part not known in advance: it is looked for in the
 * line (or in the launcher script it carries), and only a candidate that rebuilds the line exactly counts. Undefined = not known to be the
 * install's. `userName` is the account name without its domain (`os.userInfo().username` on the host), which the pipe name is made from.
 */
export function misaoTaskVersion(action: TaskExecAction, systemRoot: string, root: string, pipe: string, taskName: string): string | undefined {
  if (action.command.toLowerCase() !== path.win32.join(systemRoot, 'System32', 'conhost.exe').toLowerCase()) return undefined;
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(action.argumentsLine)?.[1];
  const searched = `${action.argumentsLine}\n${encoded === undefined ? '' : Buffer.from(encoded, 'base64').toString('utf16le').replace(/(['‘’‚‛])\1/g, '$1')}`;
  const found = new RegExp(`${escapeRegExp(path.win32.normalize(root))}\\\\(${RELEASE_NAME})\\\\misao\\.exe`, 'gi');
  for (const match of searched.matchAll(found)) {
    const version = match[1]!;
    try {
      const input = { systemRoot, exe: path.win32.join(root, version, 'misao.exe'), root, logFile: path.win32.join(root, 'misao.log'), pipe };
      if (legacyMisaoTaskArgumentsOf(input) === action.argumentsLine) return version;
      if (misaoTaskArgumentsOf({ ...input, taskName }) === action.argumentsLine) return version;
    } catch {
      // A value that cannot be written to a misao task is not the install's.
    }
  }
  return undefined;
}
