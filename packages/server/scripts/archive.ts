import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The `tar` the build scripts run. On a Windows build host that is the OS's own `System32\tar.exe` (bsdtar, which also
 * reads and writes zip), never whichever `tar` comes first on PATH: Git for Windows puts a GNU tar there, which cannot read
 * a zip and treats `C:\...` as a `host:path` remote. Elsewhere it is the `tar` on PATH.
 */
export function hostTar(): string {
  if (process.platform !== 'win32') return 'tar';
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('SystemRoot is not set, so the Windows tar.exe cannot be located');
  const tar = path.join(systemRoot, 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) throw new Error(`${tar} does not exist (Windows 10 1803 or later ships it)`);
  return tar;
}

/** Entry names of a `.tar.gz` or `.zip` (bsdtar reads both; GNU tar needs `-z` for the gzip one). */
export function listArchive(archive: string): string[] {
  const flags = archive.endsWith('.tar.gz') ? '-tzf' : '-tf';
  return execFileSync(hostTar(), [flags, archive], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 })
    .toString()
    .split(/\r?\n/)
    .filter((line) => line !== '');
}
