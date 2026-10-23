import fs from 'fs';
import path from 'path';

/**
 * The real spelling of a folder on THIS machine (8.3 short names expanded, links and junctions followed, the case on disk), found
 * the same way whether the folder exists yet or not: the nearest ancestor that exists is resolved with `realpath.native` and the
 * part that is not there yet is joined to it unchanged. So the answer for `<home>\.azito\misao` is the same before and after that
 * folder is created.
 *
 * Resolve at the boundary: the host that owns a path calls this ONCE, at its entry point (the hub for its own prefix, an agent for its
 * own home), and passes the result on. Nothing may call it for a path of another host (it would read the wrong file system).
 */
export function resolveRealPath(folder: string): string {
  const missing: string[] = [];
  let existing = folder;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return folder;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}
