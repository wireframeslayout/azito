import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Whether every file of `expected` is in `actual` with the same content (size, then SHA-256). Files that only `actual` has are ignored: a
 * folder that has been in use may have gained some. Returns the first difference as a reason, or `null` when `actual` has it all.
 */
export async function directoryContains(expected: string, actual: string): Promise<string | null> {
  const entries = fs.readdirSync(expected, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const expectedPath = path.join(expected, entry.name);
    const actualPath = path.join(actual, entry.name);
    const actualStat = fs.lstatSync(actualPath, { throwIfNoEntry: false });
    if (actualStat === undefined) return `${entry.name} is missing`;
    if (entry.isDirectory()) {
      if (!actualStat.isDirectory()) return `${entry.name} is not a folder`;
      const inner = await directoryContains(expectedPath, actualPath);
      if (inner !== null) return `${entry.name}${path.sep}${inner}`;
    } else {
      if (!actualStat.isFile()) return `${entry.name} is not a file`;
      if (actualStat.size !== fs.statSync(expectedPath).size) return `${entry.name} has another size`;
      if ((await sha256Of(expectedPath)) !== (await sha256Of(actualPath))) return `${entry.name} has other content`;
    }
  }
  return null;
}
