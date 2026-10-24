import type { HostPlatform } from '../../../shared/os/hostEnv';
import { pathApiFor } from '../../../shared/os/hostPath';

/**
 * Claude Code names a project's directory under `<config dir>/projects/` after the working directory. The rule is Claude Code's
 * own, read from its code (@anthropic-ai/claude-code 2.0.50 `cli.js`, and the 2.1.310 native binary):
 *
 *   name = cwd.replace(/[^a-zA-Z0-9]/g, '-')                       // every character but an ASCII letter / digit, per UTF-16 unit
 *   if (name.length > 200) name = name.slice(0, 200) + '-' + Math.abs(hash(cwd)).toString(36)
 *   hash(s) = the Java `String.hashCode` over UTF-16 units (h = (h << 5) - h + c | 0)
 *
 * So `_`, spaces, and each non-ASCII character are `-` too (`日本語` -> `---`, an astral character -> `--`), a Windows
 * `C:\Users\me` is `C--Users-me`, and a path over 200 characters is cut and given a hash suffix of the whole path. The
 * older `[/.]` -> `-` rule only agreed with this for plain paths.
 */
const MAX_NAME_LENGTH = 200;

function javaStringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (((hash << 5) - hash) + value.charCodeAt(i)) | 0;
  return hash;
}

/**
 * The directory name Claude Code gives sessions started in `workingDirectory` (a path of a host of `platform`). Trailing
 * separators are dropped first (Claude's own cwd never has one), but a root keeps its separator (`/`, `C:\`).
 */
export function claudeProjectDirName(platform: HostPlatform, workingDirectory: string): string {
  const root = pathApiFor(platform).parse(workingDirectory).root;
  const trimmed = workingDirectory.slice(root.length).replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  const cwd = root + trimmed;
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_NAME_LENGTH)}-${Math.abs(javaStringHash(cwd)).toString(36)}`;
}
