import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface InstallInventory {
  directories: string[];
  files: Array<{ path: string; sha256: string }>;
}

export interface InstallFileIdentity {
  device: string;
  file: string;
  created: string;
}

export const installIdentitySchema = z.object({ device: z.string().regex(/^\d+$/), file: z.string().regex(/^\d+$/), created: z.string().regex(/^\d+$/) }).strict();

export function sameInstallFileIdentity(a: InstallFileIdentity | null, b: InstallFileIdentity): boolean {
  return a !== null && a.file !== '0' && a.created !== '0' && a.device === b.device && a.file === b.file && a.created === b.created;
}

/** Stable filesystem identity lets a recorded data file change without treating a replacement as the same file. */
export function readInstallFileIdentity(target: string): InstallFileIdentity {
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`${target} is a link`);
  return { device: stat.dev.toString(), file: stat.ino.toString(), created: stat.birthtimeNs.toString() };
}

/** Refuse a link or volume mount at any point in the path, including the root itself. */
export function assertRealDirectoryChain(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} is not a real directory`);
    const parent = path.dirname(current);
    if (parent === current) break;
    const expected = path.join(fs.realpathSync.native(parent), path.basename(current));
    const actual = fs.realpathSync.native(current);
    const same = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    if (!same) throw new Error(`${current} is a mount point or link`);
    current = parent;
  }
}

export function hashInstallFile(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** A link or mount point is never entered, even when it points back inside the tree. */
export function readInstallInventory(root: string): InstallInventory {
  assertRealDirectoryChain(root);
  const realRoot = fs.realpathSync.native(root);
  const result: InstallInventory = { directories: [], files: [] };
  const visit = (dir: string, relative: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const name = path.join(relative, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`${name} is a link`);
      if (stat.isDirectory()) {
        const expected = path.join(realRoot, name);
        const actual = fs.realpathSync.native(full);
        const same = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
        if (!same) throw new Error(`${name} is a mount point or link`);
        result.directories.push(name);
        visit(full, name);
      } else if (stat.isFile()) {
        result.files.push({ path: name, sha256: hashInstallFile(full) });
      } else throw new Error(`${name} is not a regular file or directory`);
    }
  };
  visit(root, '');
  return result;
}
