import fs from 'fs';
import path from 'path';
import type { HostEnv } from './hostEnv';

/**
 * The `tar` this host runs. On Windows that is the OS's own `System32\tar.exe` (bsdtar, which also reads and writes zip), found by
 * absolute path, never whichever `tar` comes first on PATH: Git for Windows puts a GNU tar there, which cannot read a zip and treats
 * `C:\...` as a `host:path` remote. Elsewhere it is the `tar` on PATH.
 *
 * Resolve at the boundary: the entry point passes its `HostEnv` (the build scripts pass the same two values from `process`).
 */
export function hostTarOf(host: Pick<HostEnv, 'platform' | 'systemRoot'>, exists: (file: string) => boolean = fs.existsSync): string {
  if (host.platform !== 'win32') return 'tar';
  if (!host.systemRoot) throw new Error('SystemRoot is not set, so the Windows tar.exe cannot be located');
  const tar = path.win32.join(host.systemRoot, 'System32', 'tar.exe');
  if (!exists(tar)) throw new Error(`${tar} does not exist (Windows 10 1803 or later ships it)`);
  return tar;
}
